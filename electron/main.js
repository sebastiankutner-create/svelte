// Electron main process for the TARS assistant.
// The UI is served from http://127.0.0.1:<free port>, never file:// (YouTube embeds reject
// file:// pages with error 153).
import path from 'node:path';
// @ts-ignore -- `electron` is provided by the host app, not installed in this repo
// prettier-ignore
import { app, BrowserWindow, ipcMain, desktopCapturer, screen, systemPreferences, powerMonitor, shell } from 'electron';
import {
	claim_single_instance,
	create_memory,
	create_mission_log,
	load_renderer,
	register_computer_control,
	save_memory_on_exit
} from './computer-control/index.js';

/** @type {any} */
let win = null;

// a second launch focuses this window and exits before touching the memory file
if (claim_single_instance(app, () => win)) {
	const mission_log = create_mission_log({ get_window: () => win });
	const memory = create_memory({ log: mission_log.log });
	save_memory_on_exit({ app, memory, powerMonitor });

	app.whenReady().then(async () => {
		win = new BrowserWindow({
			width: 1100,
			height: 750,
			webPreferences: {
				preload: path.join(import.meta.dirname, 'preload.cjs'),
				contextIsolation: true,
				sandbox: true,
				nodeIntegration: false,
				autoplayPolicy: 'no-user-gesture-required',
				backgroundThrottling: false
			}
		});
		win.on('closed', () => {
			win = null;
		});

		register_computer_control({
			app,
			ipcMain,
			get_window: () => win,
			desktopCapturer,
			screen,
			systemPreferences,
			memory,
			mission_log,
			speak: (/** @type {string} */ _text) => {
				/* your TARS voice */
			}
		});

		try {
			const server = await load_renderer(win, path.join(import.meta.dirname, 'renderer'), {
				open_external: (url) => shell.openExternal(url)
			});
			mission_log.log({
				level: 'info',
				source: 'app',
				event: 'renderer_served',
				message: `Interface served from ${server.url}`
			});
		} catch (e) {
			mission_log.log({
				level: 'error',
				source: 'app',
				event: 'renderer_failed',
				message: `Couldn't load the interface: ${/** @type {Error} */ (e).message}`
			});
		}
	});

	app.on('window-all-closed', () => app.quit());
}
