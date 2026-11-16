import { ACTIONS, canonIntent } from './canon-intent.js';
import { fill_link, load_apps, match_app } from './apps.js';
import { launch } from './launcher.js';
import { parse_screen_request } from './screen-intent.js';
import { create_screen_analyzer } from './screen-vision.js';
import { parse_video_command, parse_volume } from './video-intent.js';
import { is_video_id, search_youtube, YouTubeSearchError } from './youtube-search.js';

/** @import { AppDefinition } from './default-apps.js' */
/** @import { LinkDefinition } from './default-links.js' */
/** @import { LaunchDeps } from './launcher.js' */
/** @import { ScreenAnalyzerOptions, VisionOptions } from './screen-vision.js' */
/** @import { CaptureDeps } from './screen-capture.js' */
/** @import { VideoResult } from './youtube-search.js' */

export { ACTIONS, canonIntent } from './canon-intent.js';
export { fill_link, load_apps, match_app } from './apps.js';
export { default_links, default_vars } from './default-links.js';
export { launch } from './launcher.js';
export { default_apps } from './default-apps.js';
export { parse_screen_request } from './screen-intent.js';
export { capture_all_screens } from './screen-capture.js';
export { parse_video_command, parse_volume } from './video-intent.js';
export { extract_first_video, search_url, search_youtube } from './youtube-search.js';
export { start_renderer_server } from './loopback-server.js';
export {
	ask_vision_model,
	create_screen_analyzer,
	for_speech,
	DEFAULT_VISION_MODEL,
	TARS_PERSONA
} from './screen-vision.js';

/** @typedef {'play_video' | 'pause_video' | 'resume_video' | 'set_volume'} VideoAction */
/** @type {Set<string>} */
const VIDEO_ACTIONS = new Set([
	ACTIONS.PLAY_VIDEO,
	ACTIONS.PAUSE_VIDEO,
	ACTIONS.RESUME_VIDEO,
	ACTIONS.SET_VOLUME
]);

export const IPC_CHANNEL = 'computer-control:run';
export const UTTERANCE_CHANNEL = 'computer-control:utterance';
/** main → renderer channel carrying {@link VideoMessage}s */
export const VIDEO_CHANNEL = 'assistant:video';

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
 * @property {string} [question] for analyze_screen: what to answer about the screen
 * @property {string} [video_id] for play_video: play this video instead of searching
 * @property {number | string} [volume] for set_volume: 0–100 (or words like "forty")
 */

/**
 * @typedef {{ type: 'load', video_id: string, title: string | null }
 *   | { type: 'command', func: 'pauseVideo' | 'playVideo' | 'setVolume', args: unknown[] }} VideoMessage
 */

/**
 * @typedef {object} VideoOptions
 * @property {(message: VideoMessage) => boolean} send Deliver to the renderer's player; `false` if there's no window.
 * @property {(query: string) => Promise<VideoResult | null>} [search] Defaults to scraping YouTube search.
 * @property {(text: string) => unknown} [speak] Spoken feedback for voice commands.
 */

/**
 * @typedef {{ ok: true, action: string, message: string, pid?: number, video_id?: string, volume?: number, question?: string | null, screens?: number, apps?: Array<{ id: string, name: string }>, links?: Array<{ id: string, name: string }> }
 *   | { ok: false, action: string | null, error: string }} RunResult
 */

/**
 * @typedef {LaunchDeps & {
 *   user_data_dir: string,
 *   warn?: (message: string) => void,
 *   screen?: ScreenAnalyzerOptions,
 *   video?: VideoOptions
 * }} Options
 */

/**
 * @param {Options} options
 */
export function create_computer_control(options) {
	const { user_data_dir, warn = () => {}, screen, video, ...launch_deps } = options;
	/** @type {string | null} the video the player was last told to load */
	let current_video = null;
	const analyzer = screen ? create_screen_analyzer(screen) : null;

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
		const action_text = first_string(command.action);

		const loaded = apps();
		const { apps: list, links, file } = loaded;
		const deps = { ...launch_deps, apps_file: file };

		/** @param {string} phrase */
		const match_any = (phrase) => match_app(phrase, [...list, ...links]);

		let action = canonIntent(action_text);
		if (action === null && parse_screen_request(action_text)) action = ACTIONS.ANALYZE_SCREEN;

		if (action === ACTIONS.ANALYZE_SCREEN) {
			const explicit = first_string(command.question, command.query, command.target);
			/** @type {string | null} */
			let question = null;
			if (explicit) {
				// "look at my screen and tell me X" may arrive whole in the question field
				const parsed = parse_screen_request(explicit);
				if (parsed) question = parsed.question;
				else if (canonIntent(explicit) !== ACTIONS.ANALYZE_SCREEN) question = explicit;
			} else {
				question = parse_screen_request(action_text)?.question ?? null;
			}
			return analyze_screen(question);
		}

		if (action === null) action = parse_video_command(action_text)?.action ?? null;
		if (action !== null && VIDEO_ACTIONS.has(action)) {
			return video_action(/** @type {VideoAction} */ (action), command);
		}

		if (action === null) {
			if (action_text) {
				// the AI put the whole request in `action`, e.g. "new Google Doc" — try it as a phrase
				const entry = target ? null : match_any(action_text);
				if (!entry) {
					return {
						ok: false,
						action: null,
						error: `I don't know how to "${action_text}". Supported actions: ${Object.values(ACTIONS).join(', ')}.`
					};
				}
				return open_entry(ACTIONS.OPEN_APP, entry);
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

		if (action === ACTIONS.LIST_APPS) {
			return {
				ok: true,
				action,
				message: `Apps: ${list.map((a) => a.name).join(', ')}. Links: ${links.map((l) => l.name).join(', ')}.`,
				apps: list.map((a) => ({ id: a.id, name: a.name })),
				links: links.map((l) => ({ id: l.id, name: l.name }))
			};
		}

		if (action === ACTIONS.OPEN_URL) {
			const raw_url = url ?? (target && looks_like_url(target) ? target : undefined);

			if (raw_url) {
				return open_url(action, raw_url, first_string(command.browser, command.app));
			}

			// "go to instagram" / { action: 'open website', target: 'new google doc' }
			const phrase = target ?? action_text;
			const link = phrase ? match_app(phrase, links) : null;
			if (link) return open_entry(action, link);

			const named_app = target ? match_app(target, list) : null;
			if (target && !named_app?.browser) {
				return {
					ok: false,
					action,
					error: `I don't have a web address for "${target}". You can add it to "links" in ${file}.`
				};
			}

			// "browse the web" with no address: just open the browser
			const browser = pick_browser(list, first_string(command.browser, named_app?.id));
			if (!browser) return { ok: false, action, error: `No browser is configured in ${file}.` };
			return with_action(action, await launch(browser, [], deps));
		}

		// OPEN_APP — "open instagram" with no target is matched on the action text itself
		const phrase = target ?? action_text;
		const entry = phrase ? match_any(phrase) : null;
		if (!entry) {
			if (!target) return { ok: false, action, error: 'Which app should I open?' };
			return {
				ok: false,
				action,
				error: `I don't know an app or link for "${target}". Known apps: ${list.map((a) => a.name).join(', ')}. You can add more in ${file}.`
			};
		}

		return open_entry(action, entry);

		/**
		 * @param {string} action
		 * @param {AppDefinition | LinkDefinition} entry
		 * @returns {Promise<RunResult>}
		 */
		async function open_entry(action, entry) {
			if (!('url' in entry)) {
				return with_action(action, await launch(entry, [], deps));
			}

			const { url: filled, missing } = fill_link(entry.url, loaded.vars);
			const result = await open_url(
				action,
				filled,
				first_string(command.browser, entry.browser),
				entry.name
			);
			if (result.ok && missing.length > 0) {
				result.message += ` (set ${missing.map((m) => `"${m}"`).join(', ')} under "vars" in ${file} to go straight to your page)`;
			}
			return result;
		}

		/**
		 * Websites are always handed to the browser as a command-line argument.
		 * @param {string} action
		 * @param {string} raw_url
		 * @param {string} [browser_name]
		 * @param {string} [label]
		 * @returns {Promise<RunResult>}
		 */
		async function open_url(action, raw_url, browser_name, label) {
			const browser = pick_browser(list, browser_name);
			if (!browser) return { ok: false, action, error: `No browser is configured in ${file}.` };

			const href = to_web_url(raw_url);
			if (!href) {
				return { ok: false, action, error: `"${raw_url}" doesn't look like a web address.` };
			}

			const result = await launch(browser, [href], deps);
			return with_action(
				action,
				result.ok ? { ...result, message: `Opened ${label ?? href} in ${browser.name}` } : result
			);
		}
	}

	/**
	 * @param {string | null} question
	 * @returns {Promise<RunResult>}
	 */
	async function analyze_screen(question) {
		const action = ACTIONS.ANALYZE_SCREEN;
		if (!analyzer) {
			return {
				ok: false,
				action,
				error:
					'Screen capture is not set up: pass desktopCapturer and screen to register_computer_control.'
			};
		}
		const result = await analyzer.analyze(question);
		return result.ok
			? {
					ok: true,
					action,
					message: result.text,
					question: result.question,
					screens: result.screens
				}
			: { ok: false, action, error: result.error };
	}

	/**
	 * @param {VideoAction} action
	 * @param {Command} command
	 * @returns {Promise<RunResult>}
	 */
	async function video_action(action, command) {
		if (!video) {
			return {
				ok: false,
				action,
				error: "The video player isn't set up: pass get_window to register_computer_control."
			};
		}

		const action_text = first_string(command.action);
		const detail = first_string(command.query, command.target);
		const parsed = parse_video_command(action_text) ?? parse_video_command(detail);

		/** @param {VideoMessage} message */
		const send = (message) => {
			try {
				return video.send(message);
			} catch {
				return false;
			}
		};
		const no_window = {
			ok: /** @type {const} */ (false),
			action,
			error: "The assistant window isn't open, so there's nowhere to play video."
		};

		if (action === ACTIONS.PLAY_VIDEO) {
			/** @type {VideoResult | null} */
			let found = is_video_id(command.video_id)
				? { video_id: command.video_id, title: null }
				: null;
			// the query may be in the action ("play a video about X") or the target ("a video about X")
			const play = [
				parse_video_command(action_text),
				parse_video_command(detail),
				parse_video_command(`play ${detail}`)
			].find((p) => p?.action === 'play_video');
			const query = play?.action === 'play_video' ? play.query : detail;

			if (!found) {
				// "play the video" with nothing to search for means resume
				if (!query) return video_action(ACTIONS.RESUME_VIDEO, command);
				try {
					found = await (video.search ?? search_youtube)(query);
				} catch (e) {
					const error =
						e instanceof YouTubeSearchError
							? e.message
							: `YouTube search failed: ${/** @type {Error} */ (e).message}`;
					return { ok: false, action, error };
				}
				if (!found) return { ok: false, action, error: `I couldn't find a video about ${query}.` };
			}

			if (!send({ type: 'load', video_id: found.video_id, title: found.title })) return no_window;
			current_video = found.video_id;
			return {
				ok: true,
				action,
				message: found.title ? `Playing ${found.title}` : `Playing a video about ${query}`,
				video_id: found.video_id
			};
		}

		if (current_video === null) {
			return {
				ok: false,
				action,
				error: "There's no video playing. Ask me to play a video about something first."
			};
		}

		if (action === ACTIONS.SET_VOLUME) {
			const volume =
				parse_volume(command.volume) ??
				(parsed?.action === 'set_volume' ? parsed.volume : null) ??
				parse_volume(detail) ??
				parse_volume(/\d+/.exec(action_text ?? '')?.[0]);
			if (volume === null) {
				return { ok: false, action, error: 'What volume? Give me a number from 0 to 100.' };
			}
			if (!send({ type: 'command', func: 'setVolume', args: [volume] })) return no_window;
			return { ok: true, action, message: `Volume set to ${volume}`, volume };
		}

		const pause = action === ACTIONS.PAUSE_VIDEO;
		if (!send({ type: 'command', func: pause ? 'pauseVideo' : 'playVideo', args: [] }))
			return no_window;
		return { ok: true, action, message: pause ? 'Paused' : 'Resumed' };
	}

	/**
	 * Check a raw transcript before it goes to the language model. Screen requests and video
	 * commands are handled right here (with spoken feedback); anything else returns `null` so
	 * the caller carries on.
	 *
	 * @param {string} text
	 * @returns {Promise<RunResult | null>}
	 */
	async function handle_utterance(text) {
		const screen_request = parse_screen_request(text);
		if (screen_request) return analyze_screen(screen_request.question);

		const video_command = parse_video_command(text);
		if (!video_command) return null;

		const result = await video_action(video_command.action, {
			action: text,
			query: video_command.action === 'play_video' ? video_command.query : undefined,
			volume: video_command.action === 'set_volume' ? video_command.volume : undefined
		});
		// speak only what's worth interrupting a video for
		if (!result.ok) await say(result.error);
		else if (result.action === ACTIONS.PLAY_VIDEO) await say(result.message);
		return result;
	}

	/** @param {string} text */
	async function say(text) {
		try {
			await video?.speak?.(text);
		} catch {
			// TTS failures must not break the command
		}
	}

	return { run, apps, handle_utterance };
}

/**
 * Wire computer control into the Electron main process. See `electron/README.md` for the
 * full setup (loopback server, window, preload).
 *
 * @param {{
 *   app: { getPath(name: 'userData'): string },
 *   ipcMain: { handle(channel: string, listener: (event: unknown, arg: any) => Promise<RunResult | null>): void },
 *   get_window?: () => { isDestroyed(): boolean, webContents: { send(channel: string, ...args: unknown[]): void } } | null | undefined,
 *   desktopCapturer?: CaptureDeps['desktopCapturer'],
 *   screen?: CaptureDeps['screen'],
 *   systemPreferences?: CaptureDeps['systemPreferences'],
 *   speak?: (text: string) => unknown,
 *   vision?: VisionOptions,
 *   search?: VideoOptions['search'],
 *   warn?: (message: string) => void
 * }} electron
 */
export function register_computer_control({
	app,
	ipcMain,
	get_window,
	desktopCapturer,
	screen,
	systemPreferences,
	speak,
	vision,
	search,
	warn
}) {
	const control = create_computer_control({
		user_data_dir: app.getPath('userData'),
		warn,
		screen:
			desktopCapturer && screen
				? { ...vision, speak, capture: { desktopCapturer, screen, systemPreferences } }
				: undefined,
		video: get_window
			? {
					speak,
					search,
					send: (message) => {
						const win = get_window();
						if (!win || win.isDestroyed()) return false;
						win.webContents.send(VIDEO_CHANNEL, message);
						return true;
					}
				}
			: undefined
	});

	// seed apps.json on startup rather than on the first command
	control.apps();

	ipcMain.handle(IPC_CHANNEL, (_event, command) => control.run(command));
	ipcMain.handle(UTTERANCE_CHANNEL, (_event, text) => control.handle_utterance(text));
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
