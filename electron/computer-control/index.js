import { ACTIONS, canonIntent } from './canon-intent.js';
import { load_apps, match_app } from './apps.js';
import { launch } from './launcher.js';

/** @import { AppDefinition } from './default-apps.js' */
/** @import { LaunchDeps } from './launcher.js' */

export { ACTIONS, canonIntent } from './canon-intent.js';
export { load_apps, match_app } from './apps.js';
export { launch } from './launcher.js';
export { default_apps } from './default-apps.js';

export const IPC_CHANNEL = 'computer-control:run';

/**
 * A command as produced by the AI. Only `action` is interpreted strictly (via `canonIntent`);
 * the target can arrive under any of the usual names.
 *
 * @typedef {object} Command
 * @property {string} [action] e.g. "open_app", "Launch Application", "open website"
 * @property {string} [target] app phrase ("browse the web") or URL
 * @property {string} [app]
 * @property {string} [query]
 * @property {string} [url]
 * @property {string} [browser] which browser to open a URL in
 */

/**
 * @typedef {{ ok: true, action: string, message: string, pid?: number, apps?: Array<{ id: string, name: string }> }
 *   | { ok: false, action: string | null, error: string }} RunResult
 */

/**
 * @typedef {LaunchDeps & { user_data_dir: string, warn?: (message: string) => void }} Options
 */

/**
 * @param {Options} options
 */
export function create_computer_control(options) {
	const { user_data_dir, warn = () => {}, ...launch_deps } = options;

	function apps() {
		const result = load_apps(user_data_dir, launch_deps.platform);
		if (result.warning) warn(result.warning);
		return result;
	}

	/**
	 * @param {Command} command
	 * @returns {Promise<RunResult>}
	 */
	async function run(command) {
		if (!command || typeof command !== 'object') {
			return { ok: false, action: null, error: 'No command was given.' };
		}

		const target = first_string(command.target, command.app, command.query);
		const url = first_string(command.url);

		let action = canonIntent(command.action);

		if (action === null) {
			const has_action = typeof command.action === 'string' && command.action.trim() !== '';
			if (has_action) {
				return {
					ok: false,
					action: null,
					error: `I don't know how to "${command.action}". Supported actions: ${Object.values(ACTIONS).join(', ')}.`
				};
			}
			// no action at all — infer it from what we were given
			if (url) action = ACTIONS.OPEN_URL;
			else if (target) action = ACTIONS.OPEN_APP;
			else return { ok: false, action: null, error: 'The command had no action or target.' };
		}

		// "open app: github.com" is really a website
		if (action === ACTIONS.OPEN_APP && !url && target && looks_like_url(target)) {
			action = ACTIONS.OPEN_URL;
		}

		const { apps: list, file } = apps();
		const deps = { ...launch_deps, apps_file: file };

		if (action === ACTIONS.LIST_APPS) {
			return {
				ok: true,
				action,
				message: list.map((a) => a.name).join(', '),
				apps: list.map((a) => ({ id: a.id, name: a.name }))
			};
		}

		if (action === ACTIONS.OPEN_URL) {
			const raw_url = url ?? (target && looks_like_url(target) ? target : undefined);
			const browser = pick_browser(list, first_string(command.browser, command.app));

			if (!browser) {
				return { ok: false, action, error: `No browser is configured in ${file}.` };
			}

			if (!raw_url) {
				// "browse the web" with no address: just open the browser
				return with_action(action, await launch(browser, [], deps));
			}

			const href = to_web_url(raw_url);
			if (!href) {
				return { ok: false, action, error: `"${raw_url}" doesn't look like a web address.` };
			}

			const result = await launch(browser, [href], deps);
			return with_action(
				action,
				result.ok ? { ...result, message: `Opened ${href} in ${browser.name}` } : result
			);
		}

		// OPEN_APP
		if (!target) {
			return { ok: false, action, error: 'Which app should I open?' };
		}

		const app = match_app(target, list);
		if (!app) {
			return {
				ok: false,
				action,
				error: `I don't know an app for "${target}". Known apps: ${list.map((a) => a.name).join(', ')}. You can add more in ${file}.`
			};
		}

		return with_action(action, await launch(app, [], deps));
	}

	return { run, apps };
}

/**
 * Wire computer control into the Electron main process:
 *
 * ```js
 * import { app, ipcMain } from 'electron';
 * register_computer_control({ app, ipcMain });
 * // renderer (via preload): ipcRenderer.invoke('computer-control:run', { action: 'open app', target: 'browse the web' })
 * ```
 *
 * @param {{
 *   app: { getPath(name: 'userData'): string },
 *   ipcMain: { handle(channel: string, listener: (event: unknown, command: Command) => Promise<RunResult>): void },
 *   warn?: (message: string) => void
 * }} electron
 */
export function register_computer_control({ app, ipcMain, warn }) {
	const control = create_computer_control({ user_data_dir: app.getPath('userData'), warn });

	// seed apps.json on startup rather than on the first command
	control.apps();

	ipcMain.handle(IPC_CHANNEL, (_event, command) => control.run(command));
	return control;
}

/**
 * @param {string} action
 * @param {import('./launcher.js').LaunchResult} result
 * @returns {RunResult}
 */
function with_action(action, result) {
	return { ...result, action };
}

/**
 * @param {...unknown} values
 */
function first_string(...values) {
	for (const v of values) {
		if (typeof v === 'string' && v.trim() !== '') return v.trim();
	}
	return undefined;
}

/**
 * @param {AppDefinition[]} apps
 * @param {string} [name]
 */
function pick_browser(apps, name) {
	const browsers = apps.filter((a) => a.browser);
	if (name) {
		const named = match_app(name, browsers);
		if (named) return named;
	}
	return browsers.find((a) => a.default_browser) ?? browsers[0] ?? null;
}

/**
 * @param {string} value
 */
function looks_like_url(value) {
	return (
		/^https?:\/\//i.test(value) ||
		/^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(:\d+)?(\/\S*)?$/i.test(value)
	);
}

/**
 * Normalise to an absolute http(s) URL. Anything else (file:, javascript:, strings that
 * would be parsed as command-line flags) is rejected.
 *
 * @param {string} value
 * @returns {string | null}
 */
function to_web_url(value) {
	const has_scheme =
		/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ||
		/^(javascript|file|data|mailto|vbscript|about):/i.test(value);
	const candidate = has_scheme ? value : `https://${value}`;
	try {
		const parsed = new URL(candidate);
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
		const host = parsed.hostname;
		if (!/^[a-z0-9[]/i.test(host)) return null;
		if (!host.includes('.') && host !== 'localhost' && !host.startsWith('[')) return null;
		return parsed.href;
	} catch {
		return null;
	}
}
