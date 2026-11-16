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
		return Promise.resolve({
			ok: status < 400,
			status,
			json: () => Promise.resolve(body),
			text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body))
		});
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
	assert.equal(warnings.length, 2);
	assert.match(warnings[0], /offline/);
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
