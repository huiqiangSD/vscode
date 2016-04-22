/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import {app, ipcMain as ipc} from 'electron';
import fs = require('fs');
import nls = require('vs/nls');
import {assign} from 'vs/base/common/objects';
import platform = require('vs/base/common/platform');
import env = require('vs/workbench/electron-main/env');
import windows = require('vs/workbench/electron-main/windows');
import { ILifecycleService, LifecycleService } from 'vs/workbench/electron-main/lifecycle';
import { VSCodeMenu } from 'vs/workbench/electron-main/menus';
import settings = require('vs/workbench/electron-main/settings');
import {IUpdateManager, UpdateManager} from 'vs/workbench/electron-main/update-manager';
import {Server, serve, connect} from 'vs/base/parts/ipc/node/ipc.net';
import {getUserEnvironment} from 'vs/base/node/env';
import {TPromise} from 'vs/base/common/winjs.base';
import {AskpassChannel} from 'vs/workbench/parts/git/common/gitIpc';
import {GitAskpassService} from 'vs/workbench/parts/git/electron-main/askpassService';
import {spawnSharedProcess} from 'vs/workbench/electron-main/sharedProcess';
import {Mutex} from 'windows-mutex';
import {LaunchService, ILaunchChannel, LaunchChannel, LaunchChannelClient} from './launch';
import {ServicesAccessor, IInstantiationService} from 'vs/platform/instantiation/common/instantiation';
import {InstantiationService} from 'vs/platform/instantiation/common/instantiationService';
import {ServiceCollection} from 'vs/platform/instantiation/common/serviceCollection';
import {SyncDescriptor} from 'vs/platform/instantiation/common/descriptors';
import {ILogService, MainLogService} from './log';
import {IStorageService, StorageService} from './storage';

function quit(accessor: ServicesAccessor, error?: Error);
function quit(accessor: ServicesAccessor, message?: string);
function quit(accessor: ServicesAccessor, arg?: any) {
	const logService = accessor.get(ILogService);

	let exitCode = 0;
	if (typeof arg === 'string') {
		logService.log(arg);
	} else {
		exitCode = 1; // signal error to the outside
		if (arg.stack) {
			console.error(arg.stack);
		} else {
			console.error('Startup error: ' + arg.toString());
		}
	}

	process.exit(exitCode); // in main, process.exit === app.exit
}

function main(accessor: ServicesAccessor, ipcServer: Server, userEnv: env.IProcessEnvironment): void {
	const instantiationService = accessor.get(IInstantiationService);
	const logService = accessor.get(ILogService);
	const envService = accessor.get(env.IEnvService);
	const windowManager = accessor.get(windows.IWindowsManager);
	const lifecycleService = accessor.get(ILifecycleService);
	const updateManager = accessor.get(IUpdateManager);

	// We handle uncaught exceptions here to prevent electron from opening a dialog to the user
	process.on('uncaughtException', (err: any) => {
		if (err) {

			// take only the message and stack property
			let friendlyError = {
				message: err.message,
				stack: err.stack
			};

			// handle on client side
			windowManager.sendToFocused('vscode:reportError', JSON.stringify(friendlyError));
		}

		console.error('[uncaught exception in main]: ' + err);
		if (err.stack) {
			console.error(err.stack);
		}
	});

	logService.log('### VSCode main.js ###');
	logService.log(env.appRoot, envService.cliArgs);

	// Setup Windows mutex
	let windowsMutex: Mutex = null;
	try {
		const Mutex = (<any>require.__$__nodeRequire('windows-mutex')).Mutex;
		windowsMutex = new Mutex(env.product.win32MutexName);
	} catch (e) {
		// noop
	}

	// Register IPC services
	const launchService = instantiationService.createInstance(LaunchService);
	const launchChannel = new LaunchChannel(launchService);
	ipcServer.registerChannel('launch', launchChannel);

	const askpassService = new GitAskpassService();
	const askpassChannel = new AskpassChannel(askpassService);
	ipcServer.registerChannel('askpass', askpassChannel);

	// Used by sub processes to communicate back to the main instance
	process.env['VSCODE_PID'] = '' + process.pid;
	process.env['VSCODE_IPC_HOOK'] = env.mainIPCHandle;
	process.env['VSCODE_SHARED_IPC_HOOK'] = env.sharedIPCHandle;

	// Spawn shared process
	const sharedProcess = instantiationService.invokeFunction(spawnSharedProcess);

	// Make sure we associate the program with the app user model id
	// This will help Windows to associate the running program with
	// any shortcut that is pinned to the taskbar and prevent showing
	// two icons in the taskbar for the same app.
	if (platform.isWindows && env.product.win32AppUserModelId) {
		app.setAppUserModelId(env.product.win32AppUserModelId);
	}

	// Set programStart in the global scope
	global.programStart = envService.cliArgs.programStart;

	function dispose() {
		if (ipcServer) {
			ipcServer.dispose();
			ipcServer = null;
		}

		sharedProcess.dispose();

		if (windowsMutex) {
			windowsMutex.release();
		}
	}

	// Dispose on app quit
	app.on('will-quit', () => {
		logService.log('App#will-quit: disposing resources');

		dispose();
	});

	// Dispose on vscode:exit
	ipc.on('vscode:exit', (event, code: number) => {
		logService.log('IPC#vscode:exit', code);

		dispose();
		process.exit(code); // in main, process.exit === app.exit
	});

	// Lifecycle
	lifecycleService.ready();

	// Load settings
	settings.manager.loadSync();

	// Propagate to clients
	windowManager.ready(userEnv);

	// Install Menu
	const menuManager = instantiationService.createInstance(VSCodeMenu);
	menuManager.ready();

	// Install Tasks
	if (platform.isWindows && env.isBuilt) {
		app.setUserTasks([
			{
				title: nls.localize('newWindow', "New Window"),
				program: process.execPath,
				arguments: '-n', // force new window
				iconPath: process.execPath,
				iconIndex: 0
			}
		]);
	}

	// Setup auto update
	updateManager.initialize();

	// Open our first window
	if (envService.cliArgs.openNewWindow && envService.cliArgs.pathArguments.length === 0) {
		windowManager.open({ cli: envService.cliArgs, forceNewWindow: true, forceEmpty: true }); // new window if "-n" was used without paths
	} else if (global.macOpenFiles && global.macOpenFiles.length && (!envService.cliArgs.pathArguments || !envService.cliArgs.pathArguments.length)) {
		windowManager.open({ cli: envService.cliArgs, pathsToOpen: global.macOpenFiles }); // mac: open-file event received on startup
	} else {
		windowManager.open({ cli: envService.cliArgs, forceNewWindow: envService.cliArgs.openNewWindow, diffMode: envService.cliArgs.diffMode }); // default: read paths from cli
	}
}

function setupIPC(accessor: ServicesAccessor): TPromise<Server> {
	const logService = accessor.get(ILogService);
	const envService = accessor.get(env.IEnvService);

	function setup(retry: boolean): TPromise<Server> {
		return serve(env.mainIPCHandle).then(server => {
			if (platform.isMacintosh) {
				app.dock.show(); // dock might be hidden at this case due to a retry
			}

			return server;
		}, err => {
			if (err.code !== 'EADDRINUSE') {
				return TPromise.wrapError(err);
			}

			// Since we are the second instance, we do not want to show the dock
			if (platform.isMacintosh) {
				app.dock.hide();
			}

			// there's a running instance, let's connect to it
			return connect(env.mainIPCHandle).then(
				client => {

					// Tests from CLI require to be the only instance currently (TODO@Ben support multiple instances and output)
					if (envService.isTestingFromCli) {
						const msg = 'Running extension tests from the command line is currently only supported if no other instance of Code is running.';
						console.error(msg);
						client.dispose();
						return TPromise.wrapError(msg);
					}

					logService.log('Sending env to running instance...');

					const channel = client.getChannel<ILaunchChannel>('launch');
					const service = new LaunchChannelClient(channel);

					return service.start(envService.cliArgs, process.env)
						.then(() => client.dispose())
						.then(() => TPromise.wrapError('Sent env to running instance. Terminating...'));
				},
				err => {
					if (!retry || platform.isWindows || err.code !== 'ECONNREFUSED') {
						return TPromise.wrapError(err);
					}

					// it happens on Linux and OS X that the pipe is left behind
					// let's delete it, since we can't connect to it
					// and the retry the whole thing
					try {
						fs.unlinkSync(env.mainIPCHandle);
					} catch (e) {
						logService.log('Fatal error deleting obsolete instance handle', e);
						return TPromise.wrapError(e);
					}

					return setup(false);
				}
			);
		});
	}

	return setup(true);
}

// TODO: isolate
const services = new ServiceCollection();

services.set(env.IEnvService, new SyncDescriptor(env.EnvService));
services.set(ILogService, new SyncDescriptor(MainLogService));
services.set(windows.IWindowsManager, new SyncDescriptor(windows.WindowsManager));
services.set(ILifecycleService, new SyncDescriptor(LifecycleService));
services.set(IStorageService, new SyncDescriptor(StorageService));
services.set(IUpdateManager, new SyncDescriptor(UpdateManager));

const instantiationService = new InstantiationService(services);

// On some platforms we need to manually read from the global environment variables
// and assign them to the process environment (e.g. when doubleclick app on Mac)
getUserEnvironment()
	.then(userEnv => {
		assign(process.env, userEnv);
		// Make sure the NLS Config travels to the rendered process
		// See also https://github.com/Microsoft/vscode/issues/4558
		userEnv['VSCODE_NLS_CONFIG'] = process.env['VSCODE_NLS_CONFIG'];

		return instantiationService.invokeFunction(setupIPC)
			.then(ipcServer => instantiationService.invokeFunction(main, ipcServer, userEnv));
	})
	.done(null, err => instantiationService.invokeFunction(quit, err));