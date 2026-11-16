import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	canonIntent,
	create_computer_control,
	extract_first_video,
	parse_video_command,
	parse_volume,
	register_computer_control,
	search_url,
	search_youtube,
	start_renderer_server
} from './index.js';
import { create_youtube_player, embed_url } from '../renderer/youtube-player.js';

test('parse_video_command understands the spoken commands', () => {
	/** @type {Record<string, unknown>} */
	const cases = {
		'play a video about black holes': { action: 'play_video', query: 'black holes' },
		'TARS, play a video about how jet engines work.': {
			action: 'play_video',
			query: 'how jet engines work'
		},
		'Play me a video on sourdough starters please': {
			action: 'play_video',
			query: 'sourdough starters'
		},
		'play some videos of cats falling off tables': {
			action: 'play_video',
			query: 'cats falling off tables'
		},
		'play lofi beats on youtube': { action: 'play_video', query: 'lofi beats' },
		'search youtube for rust tutorials': { action: 'play_video', query: 'rust tutorials' },
		'pause the video': { action: 'pause_video' },
		'Pause.': { action: 'pause_video' },
		'stop the video': { action: 'pause_video' },
		'resume the video': { action: 'resume_video' },
		unpause: { action: 'resume_video' },
		'play the video': { action: 'resume_video' },
		'set volume to 40': { action: 'set_volume', volume: 40 },
		'set the volume to 75 percent': { action: 'set_volume', volume: 75 },
		'Set volume to forty five.': { action: 'set_volume', volume: 45 },
		'set volume to a hundred': { action: 'set_volume', volume: 100 },
		'set volume to max': { action: 'set_volume', volume: 100 },
		'turn the volume down to 10%': { action: 'set_volume', volume: 10 },
		'set volume to 250': { action: 'set_volume', volume: 100 }
	};
	for (const [text, expected] of Object.entries(cases)) {
		assert.deepEqual(parse_video_command(text), expected, text);
	}
	for (const text of [
		'open chrome',
		'new google doc',
		'what do you see',
		'set volume to loud',
		'',
		undefined
	]) {
		assert.equal(parse_video_command(text), null, String(text));
	}
});

test('parse_volume', () => {
	assert.equal(parse_volume(55), 55);
	assert.equal(parse_volume(-3), 0);
	assert.equal(parse_volume('30%'), 30);
	assert.equal(parse_volume('twenty-two'), 22);
	assert.equal(parse_volume('mute'), 0);
	assert.equal(parse_volume('half'), 50);
	assert.equal(parse_volume('loud'), null);
	assert.equal(parse_volume(NaN), null);
});

test('canonIntent maps AI variants of the video actions', () => {
	/** @type {Record<string, string>} */
	const cases = {
		play_video: 'play_video',
		'Play Video': 'play_video',
		playYoutubeVideo: 'play_video',
		'search youtube': 'play_video',
		'play a video about monitors': 'play_video',
		'pause video': 'pause_video',
		pauseVideo: 'pause_video',
		'stop the video': 'pause_video',
		'resume video': 'resume_video',
		unpause: 'resume_video',
		'set volume': 'set_volume',
		setVolume: 'set_volume',
		'change the volume': 'set_volume'
	};
	for (const [input, expected] of Object.entries(cases)) {
		assert.equal(canonIntent(input), expected, input);
	}
	// unchanged
	assert.equal(canonIntent('open app'), 'open_app');
	assert.equal(canonIntent('analyze screen'), 'analyze_screen');
	assert.equal(canonIntent('stop'), null);
});

/**
 * A trimmed-down results page in the shape YouTube serves: an ad and a Shorts shelf come
 * before the first real video, and strings contain braces and escaped quotes.
 */
function results_page() {
	const data = {
		contents: {
			twoColumnSearchResultsRenderer: {
				primaryContents: {
					sectionListRenderer: {
						contents: [
							{
								itemSectionRenderer: {
									contents: [
										{
											adSlotRenderer: {
												inFeedAdLayoutRenderer: {
													renderingContent: { promotedVideoRenderer: { videoId: 'AAAAAAAAAAA' } }
												}
											}
										},
										{
											reelShelfRenderer: {
												items: [{ reelItemRenderer: { videoId: 'BBBBBBBBBBB' } }]
											}
										},
										{
											videoRenderer: {
												videoId: 'dQw4w9WgXcQ',
												title: { runs: [{ text: 'Black holes, explained {in 5 "minutes"}' }] }
											}
										},
										{
											videoRenderer: {
												videoId: 'CCCCCCCCCCC',
												title: { runs: [{ text: 'Second' }] }
											}
										}
									]
								}
							}
						]
					}
				}
			}
		}
	};
	return `<!DOCTYPE html><html><head><script>var ytcfg = {"a": "}"};</script></head><body>
<script nonce="x">var ytInitialData = ${JSON.stringify(data)};</script>
<script>var other = {"videoRenderer":{"videoId":"ZZZZZZZZZZZ"}};</script></body></html>`;
}

test('extract_first_video takes the first organic result from ytInitialData', () => {
	assert.deepEqual(extract_first_video(results_page()), {
		video_id: 'dQw4w9WgXcQ',
		title: 'Black holes, explained {in 5 "minutes"}'
	});

	// layout changed: falls back to the first videoRenderer in the raw HTML
	assert.deepEqual(
		extract_first_video('<script>junk {"videoRenderer":{"videoId":"EEEEEEEEEEE","x":1}}</script>'),
		{
			video_id: 'EEEEEEEEEEE',
			title: null
		}
	);
	assert.equal(extract_first_video('<html>consent page</html>'), null);
});

test('search_youtube requests the videos-only results page', async () => {
	/** @type {Array<{ url: string, init: any }>} */
	const calls = [];
	/** @type {any} */
	const fetch = (/** @type {string} */ url, /** @type {any} */ init) => {
		calls.push({ url, init });
		return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(results_page()) });
	};
	const result = await search_youtube('black holes & "quasars"', { fetch });
	assert.equal(result?.video_id, 'dQw4w9WgXcQ');
	assert.equal(
		calls[0].url,
		'https://www.youtube.com/results?search_query=black%20holes%20%26%20%22quasars%22&sp=EgIQAQ%3D%3D'
	);
	assert.equal(search_url('x'), 'https://www.youtube.com/results?search_query=x&sp=EgIQAQ%3D%3D');
	assert.match(calls[0].init.headers.Cookie, /CONSENT=YES/);
});

/**
 * @param {{ search?: (q: string) => Promise<any>, window_open?: boolean }} [opts]
 */
function setup(opts = {}) {
	/** @type {any[]} */
	const sent = [];
	/** @type {string[]} */
	const spoken = [];
	/** @type {string[]} */
	const searches = [];
	const control = create_computer_control({
		user_data_dir: fs.mkdtempSync(path.join(os.tmpdir(), 'video-')),
		video: {
			send: (message) => {
				if (opts.window_open === false) return false;
				sent.push(message);
				return true;
			},
			search:
				opts.search ??
				((query) => {
					searches.push(query);
					return Promise.resolve({ video_id: 'dQw4w9WgXcQ', title: `A video about ${query}` });
				}),
			speak: (text) => spoken.push(text)
		}
	});
	return { control, sent, spoken, searches };
}

test('voice: play, pause, resume and volume all reach the player', async () => {
	const { control, sent, spoken, searches } = setup();

	let result = await control.handle_utterance('play a video about black holes');
	assert.deepEqual(searches, ['black holes']);
	assert.deepEqual(sent.at(-1), {
		type: 'load',
		video_id: 'dQw4w9WgXcQ',
		title: 'A video about black holes'
	});
	assert.equal(result?.ok && result.message, 'Playing A video about black holes');

	await control.handle_utterance('Pause the video');
	assert.deepEqual(sent.at(-1), { type: 'command', func: 'pauseVideo', args: [] });

	await control.handle_utterance('Resume the video');
	assert.deepEqual(sent.at(-1), { type: 'command', func: 'playVideo', args: [] });

	result = await control.handle_utterance('Set volume to 35');
	assert.deepEqual(sent.at(-1), { type: 'command', func: 'setVolume', args: [35] });
	assert.equal(result?.ok && result.volume, 35);

	// only "Playing ..." is spoken; pause/resume/volume stay quiet
	assert.deepEqual(spoken, ['Playing A video about black holes']);

	assert.equal(await control.handle_utterance('open google chrome'), null);
});

test('AI-routed video commands work with any action wording', async () => {
	const { control, sent, searches } = setup();

	await control.run({ action: 'playYoutubeVideo', query: 'jet engines' });
	assert.deepEqual(searches, ['jet engines']);

	await control.run({ action: 'play video', target: 'a video about sourdough' });
	assert.deepEqual(searches, ['jet engines', 'sourdough']);

	await control.run({ action: 'Play a video about volcanoes' });
	assert.deepEqual(searches, ['jet engines', 'sourdough', 'volcanoes']);

	await control.run({ action: 'play_video', video_id: 'M7lc1UVf-VE' });
	assert.deepEqual(sent.at(-1), { type: 'load', video_id: 'M7lc1UVf-VE', title: null });

	await control.run({ action: 'pause' });
	assert.equal(sent.at(-1).func, 'pauseVideo');

	await control.run({ action: 'play video' }); // no query → resume
	assert.equal(sent.at(-1).func, 'playVideo');

	await control.run({ action: 'setVolume', volume: 80 });
	assert.deepEqual(sent.at(-1).args, [80]);
	await control.run({ action: 'change volume', target: 'twenty' });
	assert.deepEqual(sent.at(-1).args, [20]);
	await control.run({ action: 'set volume to 65' });
	assert.deepEqual(sent.at(-1).args, [65]);
});

test('video failures are readable and spoken', async () => {
	let { control, spoken } = setup();
	let result = await control.handle_utterance('pause the video');
	assert.match(result?.ok ? '' : result?.error ?? '', /There's no video playing/);
	assert.match(spoken[0], /There's no video playing/);

	({ control, spoken } = setup({ search: () => Promise.resolve(null) }));
	await control.handle_utterance('play a video about xyzzy');
	assert.equal(spoken[0], "I couldn't find a video about xyzzy.");

	({ control, spoken } = setup({ window_open: false }));
	await control.handle_utterance('play a video about cats');
	assert.match(spoken[0], /window isn't open/);

	({ control } = setup());
	await control.handle_utterance('play a video about cats');
	result = await control.run({ action: 'set volume', target: 'loud' });
	assert.match(result.ok ? '' : result.error, /number from 0 to 100/);

	const bare = create_computer_control({
		user_data_dir: fs.mkdtempSync(path.join(os.tmpdir(), 'video-'))
	});
	result = await bare.run({ action: 'pause video' });
	assert.match(result.ok ? '' : result.error, /video player isn't set up/);
});

test('register_computer_control sends video messages to the window', async () => {
	/** @type {Map<string, Function>} */
	const handlers = new Map();
	/** @type {any[]} */
	const sent = [];
	let destroyed = false;
	register_computer_control({
		app: { getPath: () => fs.mkdtempSync(path.join(os.tmpdir(), 'video-')) },
		ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
		get_window: () => ({
			isDestroyed: () => destroyed,
			webContents: { send: (channel, message) => sent.push([channel, message]) }
		}),
		search: () => Promise.resolve({ video_id: 'dQw4w9WgXcQ', title: 'T' })
	});
	const utterance = /** @type {Function} */ (handlers.get('computer-control:utterance'));
	await utterance({}, 'play a video about anything');
	assert.deepEqual(sent, [
		['assistant:video', { type: 'load', video_id: 'dQw4w9WgXcQ', title: 'T' }]
	]);

	destroyed = true;
	const result = await utterance({}, 'pause the video');
	assert.equal(result.ok, false);
});

test('the renderer is served from an http://127.0.0.1 loopback origin', async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renderer-'));
	fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><p>hi</p>');
	fs.writeFileSync(path.join(root, 'app.js'), 'export {}');
	fs.writeFileSync(path.join(path.dirname(root), 'secret.txt'), 'nope');

	const server = await start_renderer_server(root);
	try {
		assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
		assert.notEqual(server.port, 0);

		let res = await fetch(server.url);
		assert.equal(res.status, 200);
		assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
		assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
		assert.match(
			res.headers.get('content-security-policy') ?? '',
			/frame-src https:\/\/www\.youtube-nocookie\.com/
		);
		assert.equal(await res.text(), '<!doctype html><p>hi</p>');

		res = await fetch(`${server.origin}/app.js`);
		assert.equal(res.headers.get('content-type'), 'text/javascript; charset=utf-8');

		for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt']) {
			res = await fetch(`${server.origin}${p}`);
			assert.ok(res.status === 403 || res.status === 404, `${p} → ${res.status}`);
			assert.notEqual(await res.text(), 'nope');
		}

		assert.equal((await fetch(`${server.origin}/missing.js`)).status, 404);
		assert.equal((await fetch(server.url, { method: 'POST' })).status, 405);

		// a page on another host name (DNS rebinding) is refused
		const http = await import('node:http');
		const status = await new Promise((resolve) => {
			http.get(
				{ host: '127.0.0.1', port: server.port, path: '/', headers: { Host: 'evil.example:80' } },
				(r) => {
					r.resume();
					resolve(r.statusCode);
				}
			);
		});
		assert.equal(status, 421);
	} finally {
		await server.close();
	}

	// two servers can run at once: each gets its own free port
	const a = await start_renderer_server(root);
	const b = await start_renderer_server(root);
	assert.notEqual(a.port, b.port);
	await Promise.all([a.close(), b.close()]);
});

test('embed_url uses the privacy domain and the required parameters', () => {
	assert.equal(
		embed_url('dQw4w9WgXcQ', 'http://127.0.0.1:5173'),
		'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&enablejsapi=1&modestbranding=1&rel=0&playsinline=1&controls=1&origin=http%3A%2F%2F127.0.0.1%3A5173'
	);
	assert.throws(() => embed_url('"><script>', 'http://127.0.0.1:1'));
});

/** Minimal DOM stand-ins for the player. */
function fake_dom() {
	/** @type {Array<{ data: any, origin: string }>} */
	const posted = [];
	/** @type {Array<{ fn: () => void, ms: number, cancelled: boolean }>} */
	const timers = [];
	/** @type {any} */
	let iframe = null;
	const container = {
		children: /** @type {any[]} */ ([]),
		appendChild(/** @type {any} */ el) {
			this.children.push(el);
		}
	};
	const document = {
		createElement() {
			/** @type {Record<string, () => void>} */
			const listeners = {};
			iframe = {
				attributes: /** @type {Record<string, string>} */ ({}),
				src: '',
				title: '',
				setAttribute(/** @type {string} */ k, /** @type {string} */ v) {
					this.attributes[k] = v;
				},
				addEventListener(/** @type {string} */ type, /** @type {() => void} */ fn) {
					listeners[type] = fn;
				},
				fire_load: () => listeners.load(),
				remove() {},
				contentWindow: {
					postMessage: (/** @type {string} */ data, /** @type {string} */ origin) =>
						posted.push({ data: JSON.parse(data), origin })
				}
			};
			return iframe;
		}
	};
	return {
		container,
		document,
		posted,
		timers,
		get iframe() {
			return iframe;
		},
		options: {
			document: /** @type {any} */ (document),
			origin: 'http://127.0.0.1:4321',
			set_timeout: (/** @type {() => void} */ fn, /** @type {number} */ ms) => {
				const t = { fn, ms, cancelled: false };
				timers.push(t);
				return t;
			},
			clear_timeout: (/** @type {any} */ t) => {
				t.cancelled = true;
			}
		}
	};
}

test('player waits 700ms after load, then sends raw postMessage commands', () => {
	const dom = fake_dom();
	const player = create_youtube_player(/** @type {any} */ (dom.container), dom.options);

	assert.equal(player.pause(), false, 'nothing loaded yet');

	player.load('dQw4w9WgXcQ');
	assert.equal(dom.iframe.src, embed_url('dQw4w9WgXcQ', 'http://127.0.0.1:4321'));
	assert.equal(dom.iframe.attributes.referrerpolicy, 'strict-origin-when-cross-origin');
	assert.match(dom.iframe.attributes.allow, /autoplay/);

	// commands before the iframe is ready are queued
	player.set_volume(30);
	player.pause();
	assert.equal(dom.posted.length, 0);

	dom.iframe.fire_load();
	assert.equal(dom.timers.at(-1)?.ms, 700);
	assert.equal(dom.posted.length, 0, 'nothing is sent until the 700ms delay has passed');
	dom.timers.at(-1)?.fn();

	assert.ok(dom.posted.every((p) => p.origin === 'https://www.youtube-nocookie.com'));
	assert.deepEqual(
		dom.posted.map((p) => [p.data.event, p.data.func, p.data.args]),
		[
			['listening', undefined, undefined],
			['command', 'setVolume', [30]],
			['command', 'unMute', []],
			['command', 'pauseVideo', []]
		]
	);

	dom.posted.length = 0;
	player.play();
	player.set_volume(150);
	player.set_volume(0);
	assert.deepEqual(
		dom.posted.map((p) => [p.data.func, p.data.args]),
		[
			['playVideo', []],
			['setVolume', [100]],
			['unMute', []],
			['setVolume', [0]]
		]
	);

	assert.equal(player.command('seekTo', [0]), false, 'only allow-listed commands');
	assert.equal(player.command('setVolume', ['loud']), false);

	// loading another video resets readiness and re-applies the last volume after the delay
	dom.posted.length = 0;
	player.load('M7lc1UVf-VE');
	player.pause();
	dom.iframe.fire_load();
	dom.iframe.fire_load(); // a second load event restarts the delay rather than doubling up
	assert.equal(dom.timers.at(-2)?.cancelled, true);
	dom.timers.at(-1)?.fn();
	assert.deepEqual(
		dom.posted.map((p) => p.data.func ?? p.data.event),
		['listening', 'setVolume', 'pauseVideo']
	);
});

test('player refuses to run on file://', () => {
	const dom = fake_dom();
	assert.throws(
		() =>
			create_youtube_player(/** @type {any} */ (dom.container), {
				...dom.options,
				origin: 'file://'
			}),
		/error 153/
	);
});
