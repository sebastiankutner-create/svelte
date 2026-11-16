import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
	ask_vision_model,
	claim_single_instance,
	create_memory,
	create_mission_log,
	DEFAULT_MEMORY_MODEL,
	default_memory_dir,
	read_memory,
	register_computer_control,
	save_memory_on_exit,
	write_memory
} from './index.js';
import { parse_changes } from './memory.js';

const temp_dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'memory-'));
/** @param {string} dir */
const read_json = (dir, file = 'memory.json') =>
	JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));

/**
 * Groq stand-in. `replies` are returned in order (the last one repeats).
 * @param {Array<any>} replies
 */
function fake_groq(...replies) {
	/** @type {any[]} */
	const requests = [];
	/** @type {any} */
	const fetch = (/** @type {string} */ _url, /** @type {any} */ init) => {
		requests.push(JSON.parse(init.body));
		const reply = replies[Math.min(requests.length - 1, replies.length - 1)];
		if (reply instanceof Error) return Promise.reject(reply);
		const status = reply?.status ?? 200;
		const body = reply?.status
			? reply.body
			: { choices: [{ message: { content: JSON.stringify(reply) } }] };
		const make = () => ({
			ok: status < 400,
			status,
			statusText: '',
			headers: new Headers(reply?.headers ?? {}),
			json: () =>
				typeof body === 'string'
					? Promise.reject(new SyntaxError('Unexpected token'))
					: Promise.resolve(body),
			text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
			clone: make
		});
		return Promise.resolve(make());
	};
	return { fetch, requests };
}

const NOTHING = { add: [], update: [], remove: [] };

test('memory lives in a fixed folder under the home directory, not %APPDATA%', () => {
	const saved = process.env.TARS_MEMORY_DIR;
	try {
		delete process.env.TARS_MEMORY_DIR;
		assert.equal(default_memory_dir(), path.join(os.homedir(), '.tars'));
		process.env.TARS_MEMORY_DIR = '/srv/tars';
		assert.equal(default_memory_dir(), '/srv/tars');
	} finally {
		if (saved === undefined) delete process.env.TARS_MEMORY_DIR;
		else process.env.TARS_MEMORY_DIR = saved;
	}
});

test('saves go tmp → rename, and the backup holds the previous version', () => {
	const dir = path.join(temp_dir(), 'nested', '.tars');
	const v1 = { version: 1, updated_at: '1', conversation: [], facts: [] };
	const v2 = { ...v1, updated_at: '2' };
	const v3 = { ...v1, updated_at: '3' };

	write_memory(dir, v1);
	assert.deepEqual(read_json(dir), v1);
	assert.equal(fs.existsSync(path.join(dir, 'memory.json.bak')), false);

	write_memory(dir, v2);
	assert.deepEqual(read_json(dir), v2);
	assert.deepEqual(read_json(dir, 'memory.json.bak'), v1);

	write_memory(dir, v3);
	assert.deepEqual(read_json(dir, 'memory.json.bak'), v2);

	assert.deepEqual(
		fs.readdirSync(dir).sort(),
		['memory.json', 'memory.json.bak'],
		'no tmp files left behind'
	);
});

test('a save interrupted at any point leaves usable data', () => {
	const dir = temp_dir();
	/** @type {import('./memory-store.js').MemoryData} */
	const good = {
		version: 1,
		updated_at: 'good',
		conversation: [{ role: 'user', content: 'hi', at: 'x' }],
		facts: []
	};
	const older = { ...good, updated_at: 'older' };
	write_memory(dir, older);
	write_memory(dir, good);

	// killed while writing the tmp file: the half-written tmp is ignored
	fs.writeFileSync(path.join(dir, `memory.json.${process.pid}.tmp`), '{"version":1,"conv');
	assert.deepEqual(read_memory(dir).data, good);

	// main file damaged (e.g. disk error): fall back to the backup, keep the damaged file
	fs.writeFileSync(path.join(dir, 'memory.json'), '{"version":1,"conv');
	const result = read_memory(dir);
	assert.equal(result.source, 'backup');
	assert.deepEqual(result.data, older);
	assert.match(result.warning ?? '', /memory\.json was unreadable/);
	assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('memory.json.corrupt-')));
	assert.deepEqual(read_json(dir), older, 'the backup is restored as the main file');

	// a later save must not overwrite the good backup with garbage
	fs.writeFileSync(path.join(dir, 'memory.json'), 'garbage');
	write_memory(dir, good);
	assert.deepEqual(read_json(dir, 'memory.json.bak'), older);

	// both unreadable: start empty, keep both files
	fs.writeFileSync(path.join(dir, 'memory.json'), 'x');
	fs.writeFileSync(path.join(dir, 'memory.json.bak'), 'y');
	const empty = read_memory(dir);
	assert.equal(empty.source, 'empty');
	assert.deepEqual(empty.data.conversation, []);
});

test('history and facts persist across sessions', async () => {
	const dir = temp_dir();
	const groq = fake_groq({ add: ['The user is called Sam.'], update: [], remove: [] });
	const first = create_memory({ dir, api_key: 'k', fetch: groq.fetch });
	first.record_turn("Hi, I'm Sam", 'Hello Sam.');
	await first.idle();
	first.close();

	const second = create_memory({ dir, api_key: 'k', fetch: fake_groq(NOTHING).fetch });
	assert.deepEqual(
		second.conversation().map((m) => [m.role, m.content]),
		[
			['user', "Hi, I'm Sam"],
			['assistant', 'Hello Sam.']
		]
	);
	assert.deepEqual(
		second.facts().map((f) => f.text),
		['The user is called Sam.']
	);
});

test('record_turn returns immediately even if Groq never answers', () => {
	const dir = temp_dir();
	/** @type {any} */
	const hanging = () => new Promise(() => {});
	const memory = create_memory({ dir, api_key: 'k', fetch: hanging, debounce_ms: 60_000 });

	const start = performance.now();
	memory.record_turn('remember that my cat is called Biscuit', 'Noted.');
	assert.ok(performance.now() - start < 50);

	// the turn is saved without waiting for the extraction
	memory.flush();
	assert.equal(read_json(dir).conversation.length, 2);
});

test('saves are debounced, but flush() writes synchronously', async () => {
	const dir = temp_dir();
	const memory = create_memory({ dir, debounce_ms: 30 });
	memory.record_turn('one', '1');
	memory.record_turn('two', '2');
	assert.equal(fs.existsSync(path.join(dir, 'memory.json')), false, 'not written yet');

	await new Promise((r) => setTimeout(r, 80));
	assert.equal(read_json(dir).conversation.length, 4, 'one debounced write for both turns');

	memory.record_turn('three', '3');
	memory.flush();
	assert.equal(read_json(dir).conversation.length, 6);
	assert.equal(memory.dirty, false);
});

test('background extraction adds, updates and removes facts', async () => {
	const dir = temp_dir();
	const groq = fake_groq(
		{ add: ['The user lives in Paris.', 'The user has a dog named Rex.'], update: [], remove: [] },
		NOTHING
	);
	const memory = create_memory({ dir, api_key: 'k', fetch: groq.fetch });

	memory.record_turn('I live in Paris with my dog Rex', 'Lovely.');
	await memory.idle();
	const [paris, rex] = memory.facts();
	assert.equal(paris.text, 'The user lives in Paris.');
	assert.equal(rex.text, 'The user has a dog named Rex.');

	const request = groq.requests[0];
	assert.equal(request.model, DEFAULT_MEMORY_MODEL);
	assert.deepEqual(request.response_format, { type: 'json_object' });
	assert.match(request.messages[0].content, /long-term memory/);
	assert.deepEqual(JSON.parse(request.messages[1].content), {
		known_facts: [],
		exchange: { user: 'I live in Paris with my dog Rex', assistant: 'Lovely.' }
	});

	// the next extraction sees the stored facts with their ids, and can correct them
	memory.close();
	const next = fake_groq({
		add: ['The user works as a nurse.'],
		update: [{ id: paris.id, text: 'The user lives in Berlin.' }],
		remove: [rex.id]
	});
	const memory2 = create_memory({ dir, api_key: 'k', fetch: next.fetch });
	memory2.record_turn("I moved to Berlin, I'm a nurse now. Forget the dog.", 'Got it.');
	await memory2.idle();
	assert.deepEqual(
		JSON.parse(next.requests[0].messages[1].content).known_facts.map(
			(/** @type {any} */ f) => f.id
		),
		[paris.id, rex.id]
	);
	assert.deepEqual(
		memory2.facts().map((f) => f.text),
		['The user lives in Berlin.', 'The user works as a nurse.']
	);
});

test('duplicate facts are not added twice', async () => {
	const groq = fake_groq({
		add: ['The user likes tea.', 'The user likes tea!', 'the user LIKES tea'],
		update: [],
		remove: []
	});
	const memory = create_memory({ dir: temp_dir(), api_key: 'k', fetch: groq.fetch });
	memory.record_turn('I like tea', 'Noted');
	memory.record_turn('Did I say I like tea?', 'You did');
	await memory.idle();
	assert.deepEqual(
		memory.facts().map((f) => f.text),
		['The user likes tea.']
	);
	assert.equal(groq.requests.length, 2, 'one extraction per turn, run one after another');
});

test('extraction failures are logged, never thrown', async () => {
	/** @type {string[]} */
	const warnings = [];
	const groq = fake_groq(
		new Error('offline'),
		{ status: 500, body: {} },
		{ status: 200, body: { choices: [{ message: { content: 'not json at all' } }] } }
	);
	const memory = create_memory({
		dir: temp_dir(),
		api_key: 'k',
		fetch: groq.fetch,
		warn: (w) => warnings.push(w)
	});
	memory.record_turn('a', 'b');
	memory.record_turn('c', 'd');
	memory.record_turn('e', 'f');
	await memory.idle();
	assert.equal(memory.facts().length, 0);
	assert.equal(memory.conversation().length, 6);
	assert.deepEqual(warnings, [
		"memory: Fact extraction failed: couldn't reach Groq (offline)",
		'memory: Fact extraction failed: Groq returned HTTP 500: {}',
		"memory: Fact extraction failed: the model's answer wasn't the expected JSON"
	]);
});

/**
 * Run one extraction against a fake Groq reply and return what reached the mission log.
 * @param {any} reply
 * @param {Partial<Parameters<typeof create_memory>[0]>} [options]
 */
async function log_for(reply, options = {}) {
	/** @type {any[]} */
	const printed = [];
	const log = create_mission_log({ print: (line) => printed.push(line) });
	const memory = create_memory({
		dir: temp_dir(),
		api_key: 'k',
		fetch: fake_groq(reply).fetch,
		log: log.log,
		...options
	});
	memory.record_turn('I like tea', 'Noted');
	await memory.idle();
	return { entries: log.entries(), printed };
}

test('each kind of extraction failure reaches the mission log with details', async () => {
	/** @type {Error & { cause?: unknown }} */
	const network = new TypeError('fetch failed');
	network.cause = { code: 'ENOTFOUND' };

	/** @type {Array<[any, string, string, Record<string, unknown>]>} */
	const cases = [
		[
			network,
			'network',
			"Fact extraction failed: couldn't reach Groq (fetch failed: ENOTFOUND)",
			{}
		],
		[
			Object.assign(new Error('The operation was aborted due to timeout'), {
				name: 'TimeoutError'
			}),
			'timeout',
			"Fact extraction failed: Groq didn't answer within 30s",
			{}
		],
		[
			{
				status: 401,
				body: { error: { message: 'Invalid API Key', code: 'invalid_api_key' } },
				headers: { 'x-request-id': 'req_123' }
			},
			'http',
			'Fact extraction failed: Groq rejected the API key: Invalid API Key',
			{ status: 401, code: 'invalid_api_key', request_id: 'req_123' }
		],
		[
			{ status: 429, body: { error: { message: 'Rate limit reached for model' } } },
			'http',
			'Fact extraction failed: Groq rate limit reached: Rate limit reached for model',
			{ status: 429 }
		],
		[
			{
				status: 404,
				body: { error: { message: 'The model does not exist', code: 'model_not_found' } }
			},
			'http',
			`Fact extraction failed: model "${DEFAULT_MEMORY_MODEL}" isn't available (set GROQ_MEMORY_MODEL): The model does not exist`,
			{ status: 404, code: 'model_not_found' }
		],
		[
			{ status: 502, body: '<html>Bad gateway</html>' },
			'http',
			'Fact extraction failed: Groq returned HTTP 502: <html>Bad gateway</html>',
			{ status: 502 }
		],
		[
			{ status: 200, body: '<html>captive portal</html>' },
			'bad_response',
			"Fact extraction failed: Groq's response wasn't valid JSON (Unexpected token)",
			{}
		],
		[
			{ status: 200, body: { choices: [{ message: { content: '' }, finish_reason: 'length' }] } },
			'empty_output',
			'Fact extraction failed: the model ran out of tokens before answering',
			{ finish_reason: 'length' }
		],
		[
			{ status: 200, body: { choices: [{ message: { content: 'I think the user likes tea.' } }] } },
			'bad_output',
			"Fact extraction failed: the model's answer wasn't the expected JSON",
			{ output: 'I think the user likes tea.' }
		]
	];

	for (const [reply, kind, message, detail] of cases) {
		const { entries, printed } = await log_for(reply);
		assert.equal(entries.length, 1, message);
		const [entry] = entries;
		assert.equal(entry.level, 'error');
		assert.equal(entry.source, 'memory');
		assert.equal(entry.event, 'extraction_failed');
		assert.equal(entry.message, message);
		assert.equal(entry.detail?.kind, kind);
		assert.equal(entry.detail?.model, DEFAULT_MEMORY_MODEL);
		assert.equal(typeof entry.detail?.duration_ms, 'number');
		for (const [key, value] of Object.entries(detail))
			assert.equal(entry.detail?.[key], value, `${message}: ${key}`);
		assert.match(printed[0], /ERROR memory\/extraction_failed: /);
	}
});

test('a successful extraction logs nothing', async () => {
	const { entries } = await log_for({ add: ['The user likes tea.'], update: [], remove: [] });
	assert.deepEqual(entries, []);
});

test('a missing API key is logged once, not on every turn', async () => {
	const saved = process.env.GROQ_API_KEY;
	delete process.env.GROQ_API_KEY;
	try {
		const log = create_mission_log({ print: () => {} });
		const memory = create_memory({
			dir: temp_dir(),
			fetch: fake_groq(NOTHING).fetch,
			log: log.log
		});
		memory.record_turn('a', 'b');
		memory.record_turn('c', 'd');
		await memory.idle();
		assert.deepEqual(
			log.entries().map((e) => [e.level, e.event]),
			[['warn', 'extraction_disabled']]
		);
	} finally {
		if (saved !== undefined) process.env.GROQ_API_KEY = saved;
	}
});

test('save failures and recovered memory files are logged too', () => {
	const dir = temp_dir();
	fs.writeFileSync(path.join(dir, 'memory.json'), '{ broken');
	const log = create_mission_log({ print: () => {} });
	const memory = create_memory({ dir, log: log.log, debounce_ms: 60_000 });
	assert.deepEqual(
		log.entries().map((e) => [e.level, e.event]),
		[['error', 'load_recovered']]
	);

	// make the folder unwritable by replacing it with a file
	fs.rmSync(dir, { recursive: true });
	fs.writeFileSync(dir, 'not a folder');
	memory.record_turn('a', 'b', { extract: false });
	memory.flush();
	const last = log.entries().at(-1);
	assert.equal(last?.event, 'save_failed');
	assert.match(last?.message ?? '', /^Couldn't save memory: /);
	fs.rmSync(dir);
});

test('a broken logger never breaks memory', async () => {
	const memory = create_memory({
		dir: temp_dir(),
		api_key: 'k',
		fetch: fake_groq(new Error('offline')).fetch,
		log: () => {
			throw new Error('logger exploded');
		}
	});
	memory.record_turn('a', 'b');
	await memory.idle();
	assert.equal(memory.conversation().length, 2);
});

test('the mission log forwards entries to the window and replays history', async () => {
	/** @type {any[]} */
	const sent = [];
	let open = false;
	const log = create_mission_log({
		print: () => {},
		max_entries: 3,
		get_window: () =>
			open
				? {
						isDestroyed: () => false,
						webContents: { send: (channel, entry) => sent.push([channel, entry]) }
					}
				: null
	});

	log.log({ level: 'error', source: 'memory', event: 'a', message: 'before the window opened' });
	open = true;
	log.log({ level: 'warn', source: 'memory', event: 'b', message: 'live' });
	assert.equal(sent.length, 1);
	assert.equal(sent[0][0], 'assistant:mission-log');
	assert.equal(sent[0][1].message, 'live');
	assert.equal(sent[0][1].id, 2);

	/** @type {Map<string, Function>} */
	const handlers = new Map();
	log.register_ipc({ handle: (channel, fn) => handlers.set(channel, fn) });
	const history = await /** @type {Function} */ (handlers.get('mission-log:history'))();
	assert.deepEqual(
		history.map((/** @type {any} */ e) => e.message),
		['before the window opened', 'live']
	);

	log.log({ level: 'info', source: 'x', event: 'c', message: '3' });
	log.log({ level: 'info', source: 'x', event: 'd', message: '4' });
	assert.deepEqual(
		log.entries().map((e) => e.id),
		[2, 3, 4],
		'oldest entries are dropped past max_entries'
	);
});

test('models without JSON mode are retried without it', async () => {
	const groq = fake_groq(
		{ status: 400, body: { error: { message: 'response_format json_object is not supported' } } },
		{ add: ['The user is left-handed.'], update: [], remove: [] }
	);
	const memory = create_memory({
		dir: temp_dir(),
		api_key: 'k',
		fetch: groq.fetch,
		model: 'some/model'
	});
	memory.record_turn("I'm left-handed", 'Noted');
	await memory.idle();
	assert.equal(groq.requests.length, 2);
	assert.equal(groq.requests[1].response_format, undefined);
	assert.equal(groq.requests[1].model, 'some/model');
	assert.deepEqual(
		memory.facts().map((f) => f.text),
		['The user is left-handed.']
	);
});

test('no API key: turns are stored, no extraction is attempted', async () => {
	const saved = process.env.GROQ_API_KEY;
	delete process.env.GROQ_API_KEY;
	try {
		const groq = fake_groq(NOTHING);
		const memory = create_memory({ dir: temp_dir(), fetch: groq.fetch });
		memory.record_turn('a', 'b');
		memory.record_turn('c', 'd', { extract: false });
		await memory.idle();
		assert.equal(groq.requests.length, 0);
		assert.equal(memory.conversation().length, 4);
	} finally {
		if (saved !== undefined) process.env.GROQ_API_KEY = saved;
	}
});

test('parse_changes tolerates prose around the JSON and bad entries', () => {
	assert.deepEqual(
		parse_changes('Sure! {"add": ["x", 3], "update": [{"id": "f_1"}], "remove": "nope"} Done.'),
		{
			add: ['x'],
			update: [],
			remove: []
		}
	);
	assert.equal(parse_changes('no json'), null);
});

test('remembered facts are injected into every AI call', async () => {
	const groq = fake_groq({
		add: ['The user is called Sam.', 'The user prefers metric units.'],
		update: [],
		remove: []
	});
	const memory = create_memory({ dir: temp_dir(), api_key: 'k', fetch: groq.fetch });
	assert.equal(memory.context_block(), '');

	memory.record_turn("I'm Sam, and use metric please", 'Will do.');
	await memory.idle();

	const messages = memory.build_messages({
		system: 'You are TARS.',
		user: 'How far is the moon?',
		history_messages: 2
	});
	assert.equal(messages[0].role, 'system');
	assert.match(messages[0].content, /^You are TARS\.\n\nWhat you remember about the user/);
	assert.match(
		messages[0].content,
		/- The user is called Sam\.\n- The user prefers metric units\./
	);
	assert.deepEqual(messages.slice(1), [
		{ role: 'user', content: "I'm Sam, and use metric please" },
		{ role: 'assistant', content: 'Will do.' },
		{ role: 'user', content: 'How far is the moon?' }
	]);

	// screen analysis gets them too
	const vision = fake_groq(null);
	/** @type {any} */
	const vision_fetch = (/** @type {string} */ url, /** @type {any} */ init) => {
		vision.requests.push(JSON.parse(init.body));
		return Promise.resolve({
			ok: true,
			status: 200,
			json: () => Promise.resolve({ choices: [{ message: { content: 'ok' } }] })
		});
	};
	await ask_vision_model([], null, {
		api_key: 'k',
		fetch: vision_fetch,
		context: memory.context_block
	});
	assert.match(
		vision.requests[0].messages[0].content,
		/You are TARS[\s\S]*The user is called Sam\./
	);
});

test('single-instance lock: a second launch quits and focuses the first window', () => {
	const second = Object.assign(new EventEmitter(), {
		requestSingleInstanceLock: () => false,
		quit_called: false,
		quit() {
			this.quit_called = true;
		}
	});
	assert.equal(
		claim_single_instance(second, () => null),
		false
	);
	assert.equal(second.quit_called, true);
	assert.equal(second.listenerCount('second-instance'), 0);

	/** @type {string[]} */
	const calls = [];
	const win = {
		isDestroyed: () => false,
		isMinimized: () => true,
		restore: () => calls.push('restore'),
		isVisible: () => false,
		show: () => calls.push('show'),
		moveTop: () => calls.push('moveTop'),
		focus: () => calls.push('focus')
	};
	const first = Object.assign(new EventEmitter(), {
		requestSingleInstanceLock: () => true,
		quit: () => assert.fail('must not quit')
	});
	assert.equal(
		claim_single_instance(first, () => win),
		true
	);
	first.emit('second-instance');
	assert.deepEqual(calls, ['restore', 'show', 'moveTop', 'focus']);
});

test('quitting saves immediately instead of waiting for the debounce', () => {
	const dir = temp_dir();
	const memory = create_memory({ dir, debounce_ms: 60_000 });
	const app = Object.assign(new EventEmitter(), { quit() {} });
	const power = new EventEmitter();
	save_memory_on_exit({ app, memory, powerMonitor: power });

	memory.record_turn('last words', 'goodbye');
	assert.equal(fs.existsSync(path.join(dir, 'memory.json')), false);
	app.emit('before-quit');
	assert.equal(read_json(dir).conversation.length, 2, 'written synchronously inside the event');

	// Windows log-off on a window, and OS shutdown
	const win = new EventEmitter();
	app.emit('browser-window-created', {}, win);
	memory.record_turn('again', 'ok');
	win.emit('session-end');
	assert.equal(read_json(dir).conversation.length, 4);

	memory.record_turn('shutdown', 'ok');
	power.emit('shutdown');
	assert.equal(read_json(dir).conversation.length, 6);

	app.emit('will-quit');
	memory.record_turn('after close', 'still recorded on the next flush');
	memory.flush();
	assert.equal(read_json(dir).conversation.length, 8);
});

test('register_computer_control records handled utterances and exposes memory over IPC', async () => {
	const dir = temp_dir();
	const groq = fake_groq(NOTHING);
	const memory = create_memory({ dir, api_key: 'k', fetch: groq.fetch });
	/** @type {Map<string, Function>} */
	const handlers = new Map();
	register_computer_control({
		app: { getPath: () => temp_dir() },
		ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
		get_window: () => ({ isDestroyed: () => false, webContents: { send() {} } }),
		search: () => Promise.resolve({ video_id: 'dQw4w9WgXcQ', title: 'Space' }),
		memory
	});

	const utterance = /** @type {Function} */ (handlers.get('computer-control:utterance'));
	await utterance({}, 'play a video about space');
	assert.equal(await utterance({}, 'tell me a joke'), null);
	assert.deepEqual(
		memory.conversation().map((m) => m.content),
		['play a video about space', 'Playing Space'],
		'handled commands are recorded; unhandled ones are left to the caller'
	);

	const record = /** @type {Function} */ (handlers.get('memory:record-turn'));
	await record({}, { user: 'tell me a joke', assistant: 'No.' });
	await memory.idle();
	assert.equal(groq.requests.length, 1, 'only the real conversation turn is sent for extraction');

	const build = /** @type {Function} */ (handlers.get('memory:build-messages'));
	const messages = await build({}, { system: 'S', user: 'next' });
	assert.equal(messages.at(-1).content, 'next');
	assert.ok(
		handlers.has('memory:facts') && handlers.has('memory:forget') && handlers.has('memory:context')
	);
});
