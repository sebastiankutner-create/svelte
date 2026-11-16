import fs from 'node:fs';
import process from 'node:process';
import { spawn as node_spawn } from 'node:child_process';

/** @import { AppDefinition } from './default-apps.js' */

/**
 * @typedef {{ ok: true, message: string, pid?: number } | { ok: false, error: string }} LaunchResult
 */

/**
 * @typedef {object} LaunchDeps
 * @property {typeof node_spawn} [spawn]
 * @property {(path: string) => boolean} [exists]
 * @property {NodeJS.Platform} [platform]
 * @property {string} [apps_file] Shown in error messages so the user knows where to fix paths.
 */

/**
 * Launch an app as a detached process that keeps running after the assistant exits.
 * The path is checked with `existsSync()` first, so a missing executable produces a
 * readable error instead of an ENOENT crash.
 *
 * @param {AppDefinition} app
 * @param {string[]} [extra_args] e.g. a URL for browsers
 * @param {LaunchDeps} [deps]
 * @returns {Promise<LaunchResult>}
 */
export function launch(app, extra_args = [], deps = {}) {
	const spawn = deps.spawn ?? node_spawn;
	const exists = deps.exists ?? fs.existsSync;
	const platform = deps.platform ?? process.platform;

	if (!exists(app.path)) {
		const hint = deps.apps_file ? ` Update its "path" in ${deps.apps_file}.` : '';
		return Promise.resolve({
			ok: false,
			error: `I couldn't find ${app.name} on this computer (looked for "${app.path}").${hint}`
		});
	}

	let command = app.path;
	let args = [...(app.args ?? []), ...extra_args];

	// macOS .app bundles are directories; hand them to `open -a`, which also forwards URLs
	if (platform === 'darwin' && app.path.endsWith('.app')) {
		command = '/usr/bin/open';
		args = ['-a', app.path, ...extra_args];
		if (app.args?.length) args.push('--args', ...app.args);
	}

	/** @type {import('node:child_process').ChildProcess} */
	let child;
	try {
		child = spawn(command, args, {
			detached: true,
			stdio: 'ignore',
			windowsHide: false
		});
	} catch (e) {
		return Promise.resolve(failed(app, /** @type {Error} */ (e)));
	}

	// keep running if the assistant closes
	child.unref();

	return new Promise((resolve) => {
		// Errors such as EACCES are emitted asynchronously; without a listener they would be
		// thrown as an uncaught exception and take down the main process.
		child.once('error', (e) => resolve(failed(app, e)));
		child.once('spawn', () => resolve({ ok: true, message: `Opened ${app.name}`, pid: child.pid }));
	});
}

/**
 * @param {AppDefinition} app
 * @param {Error} e
 * @returns {LaunchResult}
 */
function failed(app, e) {
	return { ok: false, error: `I couldn't start ${app.name}: ${e.message}` };
}
