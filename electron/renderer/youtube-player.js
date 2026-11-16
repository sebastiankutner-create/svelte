/**
 * YouTube player built on a plain iframe and raw postMessage commands (no IFrame API script).
 * Must run on an http(s) origin: on file:// the embed fails with error 153.
 */

export const EMBED_ORIGIN = 'https://www.youtube-nocookie.com';

/** Wait this long after the iframe's `load` event before sending it any command. */
export const COMMAND_DELAY_MS = 700;

/** Player functions the assistant may call. */
export const ALLOWED_COMMANDS = new Set([
	'playVideo',
	'pauseVideo',
	'stopVideo',
	'setVolume',
	'mute',
	'unMute'
]);

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * @param {string} video_id
 * @param {string} origin The page's own origin, e.g. `location.origin`.
 */
export function embed_url(video_id, origin) {
	if (!VIDEO_ID.test(video_id)) throw new Error(`Invalid YouTube video id: ${video_id}`);
	return (
		`${EMBED_ORIGIN}/embed/${video_id}` +
		`?autoplay=1&enablejsapi=1&modestbranding=1&rel=0&playsinline=1&controls=1` +
		`&origin=${encodeURIComponent(origin)}`
	);
}

/**
 * @typedef {object} PlayerOptions
 * @property {string} [origin] Defaults to `location.origin`.
 * @property {number} [delay_ms] Defaults to {@link COMMAND_DELAY_MS}.
 * @property {Document} [document]
 * @property {(fn: () => void, ms: number) => unknown} [set_timeout]
 * @property {(id: any) => void} [clear_timeout]
 */

/**
 * @param {HTMLElement} container Element the iframe is placed in.
 * @param {PlayerOptions} [options]
 */
export function create_youtube_player(container, options = {}) {
	const doc = options.document ?? container.ownerDocument;
	const origin = options.origin ?? doc.defaultView?.location.origin ?? '';
	const delay_ms = options.delay_ms ?? COMMAND_DELAY_MS;
	const set_timeout = options.set_timeout ?? ((fn, ms) => setTimeout(fn, ms));
	const clear_timeout = options.clear_timeout ?? ((id) => clearTimeout(id));

	if (!/^https?:\/\//.test(origin)) {
		throw new Error(
			`The YouTube embed needs an http(s) origin, got "${origin || 'none'}" (file:// fails with error 153)`
		);
	}

	/** @type {HTMLIFrameElement | null} */
	let iframe = null;
	/** @type {string | null} */
	let video_id = null;
	let ready = false;
	/** @type {unknown} */
	let timer = null;
	/** @type {Array<{ func: string, args: unknown[] }>} */
	let queue = [];
	/** @type {number | null} remembered so it carries over to the next video */
	let volume = null;

	function create_iframe() {
		const el = doc.createElement('iframe');
		el.title = 'YouTube video player';
		el.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture; fullscreen');
		el.setAttribute('allowfullscreen', '');
		// YouTube needs to know which site embeds it; never use `no-referrer` here
		el.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
		el.setAttribute('frameborder', '0');
		el.addEventListener('load', on_load);
		container.appendChild(el);
		return el;
	}

	function on_load() {
		if (timer !== null) clear_timeout(timer);
		timer = set_timeout(() => {
			timer = null;
			ready = true;
			// subscribe to state events; harmless if nobody listens
			post({ event: 'listening', id: 'assistant-player', channel: 'widget' });
			const pending = queue;
			queue = [];
			// carry the last volume over to a newly loaded video, unless a new one is already queued
			if (volume !== null && !pending.some((c) => c.func === 'setVolume'))
				send_now('setVolume', [volume]);
			for (const { func, args } of pending) send_now(func, args);
		}, delay_ms);
	}

	/** @param {unknown} message */
	function post(message) {
		iframe?.contentWindow?.postMessage(JSON.stringify(message), EMBED_ORIGIN);
	}

	/**
	 * @param {string} func
	 * @param {unknown[]} args
	 */
	function send_now(func, args) {
		post({ event: 'command', func, args, id: 'assistant-player', channel: 'widget' });
	}

	/**
	 * Load (and autoplay) a video. Commands sent before the iframe is ready are queued.
	 * @param {string} id
	 */
	function load(id) {
		const src = embed_url(id, origin);
		iframe ??= create_iframe();
		if (timer !== null) clear_timeout(timer);
		timer = null;
		ready = false;
		queue = [];
		video_id = id;
		iframe.src = src;
	}

	/**
	 * Send a raw player command, e.g. `command('pauseVideo')`.
	 * @param {string} func
	 * @param {unknown[]} [args]
	 * @returns {boolean} `false` if no video is loaded or the command isn't allowed
	 */
	function command(func, args = []) {
		if (!ALLOWED_COMMANDS.has(func) || !iframe) return false;
		if (func === 'setVolume') {
			const value = Math.max(0, Math.min(100, Math.round(Number(args[0]))));
			if (!Number.isFinite(value)) return false;
			volume = value;
			args = [value];
		}
		if (ready) send_now(func, args);
		else queue.push({ func, args });
		// setVolume doesn't lift a mute, so unmute when a non-zero volume is asked for
		if (func === 'setVolume' && volume !== null && volume > 0) {
			if (ready) send_now('unMute', []);
			else queue.push({ func: 'unMute', args: [] });
		}
		return true;
	}

	function destroy() {
		if (timer !== null) clear_timeout(timer);
		iframe?.remove();
		iframe = null;
		video_id = null;
		ready = false;
		queue = [];
	}

	return {
		load,
		command,
		pause: () => command('pauseVideo'),
		play: () => command('playVideo'),
		/** @param {number} value 0–100 */
		set_volume: (value) => command('setVolume', [value]),
		destroy,
		get video_id() {
			return video_id;
		},
		get ready() {
			return ready;
		}
	};
}
