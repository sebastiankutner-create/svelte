import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
	canonIntent,
	create_computer_control,
	DEFAULT_VISION_MODEL,
	for_speech,
	parse_screen_request,
	register_computer_control,
	TARS_PERSONA
} from './index.js';

/**
 * @param {number} width
 * @param {number} height
 * @param {number} [bytes_per_pixel]
 * @returns {any}
 */
function fake_image(width, height, bytes_per_pixel = 0) {
	return {
		isEmpty: () => width === 0,
		getSize: () => ({ width, height }),
		resize: (/** @type {{ width?: number, height?: number }} */ o) =>
			o.width
				? fake_image(o.width, Math.round((height * o.width) / width), bytes_per_pixel)
				: fake_image(
						Math.round((width * /** @type {number} */ (o.height)) / height),
						/** @type {number} */ (o.height),
						bytes_per_pixel
					),
		toJPEG: () =>
			bytes_per_pixel
				? Buffer.alloc(Math.round(width * height * bytes_per_pixel), 1)
				: Buffer.from(`${width}x${height}`)
	};
}

/**
 * @param {Array<{ id: number, width: number, height: number, scale?: number }>} displays
 * @param {{ primary?: number, bytes_per_pixel?: number, blank?: boolean }} [opts]
 */
function fake_electron(displays, opts = {}) {
	/** @type {any[]} */
	const requests = [];
	return {
		requests,
		desktopCapturer: {
			getSources: (/** @type {any} */ options) => {
				requests.push(options);
				// return them in reverse to check that the primary display comes first
				const sources = displays
					.map((d, i) => ({
						id: `screen:${i}:0`,
						name: `Screen ${i + 1}`,
						display_id: String(d.id),
						thumbnail: opts.blank
							? fake_image(0, 0)
							: fake_image(
									d.width * (d.scale ?? 1),
									d.height * (d.scale ?? 1),
									opts.bytes_per_pixel
								)
					}))
					.reverse();
				return Promise.resolve(sources);
			}
		},
		screen: {
			getAllDisplays: () =>
				displays.map((d) => ({
					id: d.id,
					size: { width: d.width, height: d.height },
					scaleFactor: d.scale ?? 1
				})),
			getPrimaryDisplay: () => ({ id: opts.primary ?? displays[0].id })
		}
	};
}

/**
 * @param {any} [reply]
 * @param {number} [status]
 */
function fake_fetch(
	reply = { choices: [{ message: { content: 'You have a terminal open.' } }] },
	status = 200
) {
	/** @type {Array<{ url: string, init: any, body: any }>} */
	const calls = [];
	/** @type {any} */
	const fetch = (/** @type {string} */ url, /** @type {any} */ init) => {
		calls.push({ url, init, body: JSON.parse(init.body) });
		return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(reply) });
	};
	return { fetch, calls };
}

/**
 * @param {{ displays?: Parameters<typeof fake_electron>[0], electron?: ReturnType<typeof fake_electron>, fetch?: ReturnType<typeof fake_fetch>, platform?: NodeJS.Platform, systemPreferences?: any, api_key?: string, model?: string }} [opts]
 */
function setup(opts = {}) {
	const electron =
		opts.electron ?? fake_electron(opts.displays ?? [{ id: 1, width: 1920, height: 1080 }]);
	const groq = opts.fetch ?? fake_fetch();
	/** @type {string[]} */
	const spoken = [];
	const control = create_computer_control({
		user_data_dir: fs.mkdtempSync(path.join(os.tmpdir(), 'screen-')),
		platform: 'linux',
		spawn: /** @type {any} */ (() => assert.fail('nothing should be spawned')),
		screen: {
			api_key: 'api_key' in opts ? opts.api_key : 'test-key',
			model: opts.model,
			fetch: groq.fetch,
			speak: (text) => spoken.push(text),
			capture: {
				desktopCapturer: electron.desktopCapturer,
				screen: electron.screen,
				systemPreferences: opts.systemPreferences,
				platform: opts.platform ?? 'linux'
			}
		}
	});
	return { control, electron, groq, spoken };
}

test('parse_screen_request recognises screen requests and splits off a question', () => {
	for (const text of [
		'analyze my screen',
		'Analyse the screen.',
		'what do you see',
		'TARS, what do you see?',
		'look at my screen',
		"what's on my screen",
		'what do you see on my screen',
		'look at my screen and tell me what you see',
		'take a look at my monitors'
	]) {
		assert.deepEqual(parse_screen_request(text), { question: null }, text);
	}

	/** @type {Record<string, string>} */
	const questions = {
		'look at my screen and tell me which test failed': 'which test failed',
		'Hey TARS, look at my screen and tell me, is this email a scam?': 'is this email a scam',
		'look at my screen and can you please tell me what time my flight leaves':
			'what time my flight leaves',
		'analyze my screen, why is the build red': 'why is the build red',
		'look at my screen then explain this error': 'this error',
		'what do you see? Is that a typo in the title?': 'Is that a typo in the title'
	};
	for (const [text, question] of Object.entries(questions)) {
		assert.deepEqual(parse_screen_request(text), { question }, text);
	}

	for (const text of [
		'open chrome',
		'new google doc',
		'screen my calls',
		'browse the web',
		undefined
	]) {
		assert.equal(parse_screen_request(text), null, String(text));
	}
});

test('canonIntent maps screen variants to analyze_screen without breaking others', () => {
	for (const v of [
		'analyze screen',
		'analyze_screen',
		'AnalyzeScreen',
		'look at screen',
		'screenshot',
		'take screenshot',
		'what do you see',
		'capture monitors'
	]) {
		assert.equal(canonIntent(v), 'analyze_screen', v);
	}
	assert.equal(canonIntent('open app'), 'open_app');
	assert.equal(canonIntent('show applications'), 'list_apps');
	assert.equal(canonIntent('open url'), 'open_url');
});

test('"analyze my screen" captures every monitor and TARS describes it by voice', async () => {
	const { control, electron, groq, spoken } = setup({
		displays: [
			{ id: 10, width: 1440, height: 900, scale: 2 },
			{ id: 20, width: 1920, height: 1080 }
		],
		fetch: fake_fetch({
			choices: [
				{
					message: {
						content: '**Well.** You are three hours into a CSS bug.\n\n- The terminal is angry.'
					}
				}
			]
		})
	});

	const result = await control.run({ action: 'analyze my screen' });

	assert.deepEqual(electron.requests, [
		{ types: ['screen'], thumbnailSize: { width: 2880, height: 1800 }, fetchWindowIcons: false }
	]);

	assert.equal(groq.calls.length, 1);
	const { url, init, body } = groq.calls[0];
	assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
	assert.equal(init.headers.Authorization, 'Bearer test-key');
	assert.equal(body.model, DEFAULT_VISION_MODEL);
	assert.equal(body.messages[0].role, 'system');
	assert.equal(body.messages[0].content, TARS_PERSONA);

	const [text, ...images] = body.messages[1].content;
	assert.match(text.text, /Tell them what you see, in your own voice/);
	assert.match(
		text.text,
		/2 screenshots, one per monitor, in this order: monitor 1 \(primary\), monitor 2/
	);
	assert.equal(images.length, 2);
	for (const image of images) {
		assert.equal(image.type, 'image_url');
		assert.match(image.image_url.url, /^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/);
	}
	// primary (2880x1800 retina) first, downscaled to 1920 wide; then the 1920x1080 one
	const decode = (/** @type {any} */ image) =>
		Buffer.from(image.image_url.url.split(',')[1], 'base64').toString();
	assert.deepEqual(images.map(decode), ['1920x1200', '1920x1080']);

	const spoken_text = 'Well. You are three hours into a CSS bug. The terminal is angry.';
	assert.deepEqual(spoken, [spoken_text]);
	assert.deepEqual(result, {
		ok: true,
		action: 'analyze_screen',
		message: spoken_text,
		question: null,
		screens: 2
	});
});

test('"look at my screen and tell me X" answers X instead of describing', async () => {
	const { control, groq, spoken } = setup();

	const result = await control.handle_utterance(
		'Hey TARS, look at my screen and tell me which test failed'
	);

	const prompt = groq.calls[0].body.messages[1].content[0].text;
	assert.match(prompt, /asked: "which test failed"/);
	assert.match(prompt, /Don't describe the screen first/);
	assert.doesNotMatch(prompt, /Tell them what you see/);
	assert.equal(result?.ok && result.question, 'which test failed');
	assert.deepEqual(spoken, ['You have a terminal open.']);

	// the same request, routed through the AI as a command
	await control.run({
		action: 'look at screen',
		question: 'look at my screen and tell me which test failed'
	});
	assert.match(groq.calls[1].body.messages[1].content[0].text, /asked: "which test failed"/);

	await control.run({ action: 'analyze_screen', query: 'is this email a scam?' });
	assert.match(groq.calls[2].body.messages[1].content[0].text, /asked: "is this email a scam\?"/);

	await control.run({ action: 'analyze_screen', query: 'what do you see' });
	assert.match(groq.calls[3].body.messages[1].content[0].text, /Tell them what you see/);
});

test('non-screen utterances fall through untouched', async () => {
	const { control, groq, spoken } = setup();
	assert.equal(await control.handle_utterance('open google chrome'), null);
	assert.equal(groq.calls.length, 0);
	assert.equal(spoken.length, 0);
});

test('large multi-monitor captures are downscaled to fit the request limit', async () => {
	const electron = fake_electron(
		[
			{ id: 1, width: 1920, height: 1080 },
			{ id: 2, width: 1920, height: 1080 },
			{ id: 3, width: 1920, height: 1080 }
		],
		{ bytes_per_pixel: 0.5 }
	);
	const { control, groq } = setup({ electron });
	await control.run({ action: 'analyze screen' });
	const images = groq.calls[0].body.messages[1].content.slice(1);
	const total = images.reduce(
		(/** @type {number} */ n, /** @type {any} */ i) => n + i.image_url.url.length,
		0
	);
	assert.equal(images.length, 3);
	assert.ok(total <= 3.5 * 1024 * 1024 + 100, String(total));
});

test('failures are spoken, not thrown', async () => {
	const saved = process.env.GROQ_API_KEY;
	delete process.env.GROQ_API_KEY;
	try {
		let { control, spoken } = setup({ api_key: undefined });
		let result = await control.run({ action: 'analyze screen' });
		assert.equal(result.ok, false);
		assert.match(spoken[0], /no Groq API key/);

		({ control, spoken } = setup({
			platform: 'darwin',
			systemPreferences: { getMediaAccessStatus: () => 'denied' }
		}));
		result = await control.run({ action: 'what do you see' });
		assert.match(spoken[0], /Screen Recording permission/);

		({ control, spoken } = setup({
			electron: fake_electron([{ id: 1, width: 100, height: 100 }], { blank: true })
		}));
		await control.run({ action: 'analyze screen' });
		assert.match(spoken[0], /couldn't capture any screen/);

		({ control, spoken } = setup({
			model: 'llama-3.2-11b-vision-preview',
			fetch: fake_fetch(
				{
					error: {
						message: 'The model `llama-3.2-11b-vision-preview` has been decommissioned',
						code: 'model_decommissioned'
					}
				},
				400
			)
		}));
		result = await control.run({ action: 'analyze screen' });
		assert.match(
			result.ok ? '' : result.error,
			/isn't available on Groq any more.*GROQ_VISION_MODEL/
		);
		assert.equal(spoken.length, 1);

		({ control, spoken } = setup({ fetch: fake_fetch({ error: { message: 'bad key' } }, 401) }));
		await control.run({ action: 'analyze screen' });
		assert.match(spoken[0], /rejected the API key/);
	} finally {
		if (saved !== undefined) process.env.GROQ_API_KEY = saved;
	}
});

test('a second request while one is running is told to wait', async () => {
	/** @type {(value: any) => void} */
	let release = () => {};
	const groq = fake_fetch();
	const slow = /** @type {any} */ (
		async (/** @type {string} */ url, /** @type {any} */ init) => {
			await new Promise((r) => (release = r));
			return groq.fetch(url, init);
		}
	);
	const { control, spoken } = setup({ fetch: { fetch: slow, calls: groq.calls } });

	const first = control.run({ action: 'analyze screen' });
	await new Promise((r) => setTimeout(r, 10));
	const second = await control.run({ action: 'analyze screen' });
	assert.equal(second.ok, false);
	assert.match(spoken[0], /still looking/);

	release(null);
	assert.equal((await first).ok, true);
});

test('a broken speak() does not crash the request', async () => {
	const electron = fake_electron([{ id: 1, width: 800, height: 600 }]);
	const control = create_computer_control({
		user_data_dir: fs.mkdtempSync(path.join(os.tmpdir(), 'screen-')),
		screen: {
			api_key: 'k',
			fetch: fake_fetch().fetch,
			speak: () => {
				throw new Error('TTS offline');
			},
			capture: { ...electron, platform: 'linux' }
		}
	});
	assert.equal((await control.run({ action: 'analyze screen' })).ok, true);
});

test('for_speech strips markdown', () => {
	assert.equal(
		for_speech(
			'# Summary\n**Bold** and _italic_ with `code` and [a link](https://x.com).\n1. one\n- two\n```js\nlet x;\n```'
		),
		'Summary Bold and italic with code and a link. one two'
	);
});

test('screen analysis without capture deps gives a readable error', async () => {
	const control = create_computer_control({
		user_data_dir: fs.mkdtempSync(path.join(os.tmpdir(), 'screen-'))
	});
	const result = await control.run({ action: 'analyze screen' });
	assert.match(result.ok ? '' : result.error, /Screen capture is not set up/);
});

test('register_computer_control exposes the utterance channel', async () => {
	const electron = fake_electron([{ id: 1, width: 800, height: 600 }]);
	/** @type {Map<string, Function>} */
	const handlers = new Map();
	/** @type {string[]} */
	const spoken = [];
	register_computer_control({
		app: { getPath: () => fs.mkdtempSync(path.join(os.tmpdir(), 'screen-')) },
		ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
		desktopCapturer: electron.desktopCapturer,
		screen: electron.screen,
		speak: (text) => spoken.push(text),
		vision: { api_key: 'k', fetch: fake_fetch().fetch }
	});
	const handler = /** @type {Function} */ (handlers.get('computer-control:utterance'));
	assert.equal(await handler({}, 'open chrome'), null);
	const result = await handler({}, 'what do you see');
	assert.equal(result.ok, true);
	assert.deepEqual(spoken, ['You have a terminal open.']);
});
