import { test } from 'node:test';
import process from 'node:process';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
	ACTIONS,
	canonIntent,
	create_computer_control,
	default_apps,
	load_apps,
	match_app,
	register_computer_control
} from './index.js';

function temp_dir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'computer-control-'));
}

/**
 * @param {{ fail?: Error }} [opts]
 */
function fake_spawn(opts = {}) {
	/** @type {Array<{ command: string, args: string[], options: any, unref: boolean }>} */
	const calls = [];
	/** @type {any} */
	const spawn = (
		/** @type {string} */ command,
		/** @type {string[]} */ args,
		/** @type {any} */ options
	) => {
		const call = { command, args, options, unref: false };
		calls.push(call);
		const child = Object.assign(new EventEmitter(), {
			pid: 1234,
			unref: () => {
				call.unref = true;
			}
		});
		queueMicrotask(() => (opts.fail ? child.emit('error', opts.fail) : child.emit('spawn')));
		return child;
	};
	return { spawn, calls };
}

/**
 * @param {Partial<Parameters<typeof create_computer_control>[0]>} [overrides]
 */
function setup(overrides = {}) {
	const dir = temp_dir();
	const { spawn, calls } = fake_spawn();
	const control = create_computer_control({
		user_data_dir: dir,
		platform: 'linux',
		spawn,
		exists: () => true,
		...overrides
	});
	return { dir, calls, control };
}

test('canonIntent maps variants to one action string', () => {
	for (const v of [
		'open app',
		'Open App',
		'launch application',
		'launch_application',
		'LaunchApp',
		'start program',
		'run',
		'open',
		'open-app',
		'OPEN_APP',
		'execute program',
		'fire up app'
	]) {
		assert.equal(canonIntent(v), ACTIONS.OPEN_APP, v);
	}
	for (const v of [
		'open url',
		'open_url',
		'openURL',
		'go to website',
		'visit site',
		'navigate',
		'browse',
		'open link',
		'open web page',
		'goto'
	]) {
		assert.equal(canonIntent(v), ACTIONS.OPEN_URL, v);
	}
	for (const v of ['list apps', 'list_apps', 'show applications', 'what apps are available']) {
		assert.equal(canonIntent(v), ACTIONS.LIST_APPS, v);
	}
	for (const v of [undefined, null, 42, '', '   ', 'delete everything']) {
		assert.equal(canonIntent(v), null, String(v));
	}
});

test('apps.json is seeded with defaults on first run and then read back', () => {
	const dir = path.join(temp_dir(), 'nested');
	const first = load_apps(dir, 'win32');
	assert.equal(first.seeded, true);
	assert.deepEqual(JSON.parse(fs.readFileSync(first.file, 'utf-8')).apps, default_apps('win32'));

	const file = path.join(dir, 'apps.json');
	fs.writeFileSync(
		file,
		JSON.stringify({
			apps: [{ id: 'x', name: 'X', path: '/x', intents: ['do x'] }, { id: 'broken' }]
		})
	);
	const second = load_apps(dir, 'win32');
	assert.equal(second.seeded, false);
	assert.deepEqual(
		second.apps.map((a) => a.id),
		['x']
	);
	assert.match(second.warning ?? '', /1 entry/);
});

test('a corrupt apps.json is left alone and defaults are used', () => {
	const dir = temp_dir();
	const file = path.join(dir, 'apps.json');
	fs.writeFileSync(file, '{ not json');
	const result = load_apps(dir, 'linux');
	assert.deepEqual(result.apps, default_apps('linux'));
	assert.match(result.warning ?? '', /Could not read/);
	assert.equal(fs.readFileSync(file, 'utf-8'), '{ not json');
});

test('match_app resolves natural phrases', () => {
	const apps = default_apps('linux');
	assert.equal(match_app('browse the web', apps)?.id, 'browser');
	assert.equal(match_app('I want to browse the web please', apps)?.id, 'browser');
	assert.equal(match_app('open google chrome', apps)?.id, 'chrome');
	assert.equal(match_app('Calculator', apps)?.id, 'calculator');
	assert.equal(match_app('browse files', apps)?.id, 'files');
	assert.equal(match_app('play some music', apps), null);
});

test('apps are launched detached and unref-ed', async () => {
	const { calls, control } = setup();
	const result = await control.run({ action: 'Launch Application', target: 'browse the web' });
	assert.deepEqual(result, { ok: true, action: 'open_app', message: 'Opened Firefox', pid: 1234 });
	assert.equal(calls.length, 1);
	assert.equal(calls[0].command, '/usr/bin/firefox');
	assert.deepEqual(calls[0].args, []);
	assert.equal(calls[0].options.detached, true);
	assert.equal(calls[0].options.stdio, 'ignore');
	assert.equal(calls[0].unref, true);
});

test('websites are passed to the browser as an argument', async () => {
	const { calls, control } = setup();

	let result = await control.run({ action: 'go to website', url: 'github.com/sveltejs' });
	assert.equal(result.ok, true);
	assert.deepEqual(calls.at(-1)?.args, ['https://github.com/sveltejs']);
	assert.equal(calls.at(-1)?.command, '/usr/bin/firefox');

	result = await control.run({ action: 'open url', url: 'https://example.com', browser: 'chrome' });
	assert.equal(result.ok && result.message, 'Opened https://example.com/ in Google Chrome');
	assert.equal(calls.at(-1)?.command, '/usr/bin/google-chrome');

	// an "open app" whose target is a URL is treated as a website
	result = await control.run({ action: 'open app', target: 'chrome.com' });
	assert.equal(result.action, 'open_url');
	assert.equal(calls.at(-1)?.command, '/usr/bin/firefox');
	assert.deepEqual(calls.at(-1)?.args, ['https://chrome.com/']);
});

test('non-web URLs are refused', async () => {
	const { calls, control } = setup();
	for (const url of ['file:///etc/passwd', 'javascript:alert(1)', '--disable-web-security']) {
		const result = await control.run({ action: 'open_url', url });
		assert.equal(result.ok, false, url);
	}
	assert.equal(calls.length, 0);
});

test('macOS .app bundles go through open -a', async () => {
	const { calls, control } = setup({ platform: 'darwin' });
	await control.run({ action: 'open_url', url: 'example.com' });
	assert.equal(calls[0].command, '/usr/bin/open');
	assert.deepEqual(calls[0].args, ['-a', '/Applications/Safari.app', 'https://example.com/']);
});

test('a missing executable returns a readable error without spawning', async () => {
	const { calls, control } = setup({ exists: () => false });
	const result = await control.run({ action: 'open app', target: 'calculator' });
	assert.equal(result.ok, false);
	assert.match(
		result.ok ? '' : result.error,
		/couldn't find Calculator .*\/usr\/bin\/gnome-calculator.*apps\.json/
	);
	assert.equal(calls.length, 0);
});

test('spawn errors are reported instead of crashing', async () => {
	const { spawn } = fake_spawn({ fail: new Error('EACCES') });
	const { control } = setup({ spawn });
	const result = await control.run({ action: 'open', target: 'terminal' });
	assert.deepEqual(result, {
		ok: false,
		action: 'open_app',
		error: "I couldn't start Terminal: EACCES"
	});
});

test('commands are never silently dropped', async () => {
	const { control } = setup();

	let result = await control.run({ action: 'reticulate splines', target: 'calculator' });
	assert.equal(result.ok, false);
	assert.match(result.ok ? '' : result.error, /Supported actions/);

	result = await control.run({ action: 'open app', target: 'play some music' });
	assert.match(result.ok ? '' : result.error, /I don't know an app/);

	result = await control.run({ target: 'calculator' });
	assert.equal(result.ok, true);

	result = await control.run({ action: 'list apps' });
	assert.equal(result.ok && result.apps?.length, 6);
});

test('a real detached process is spawned', async () => {
	const dir = temp_dir();
	const marker = path.join(dir, 'ran');
	fs.writeFileSync(
		path.join(dir, 'apps.json'),
		JSON.stringify({
			apps: [
				{
					id: 'node',
					name: 'Node',
					path: process.execPath,
					args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ok')`],
					intents: ['run node']
				}
			]
		})
	);
	const control = create_computer_control({ user_data_dir: dir });
	const result = await control.run({ action: 'launch', target: 'run node' });
	assert.equal(result.ok, true);
	for (let i = 0; i < 50 && !fs.existsSync(marker); i++)
		await new Promise((r) => setTimeout(r, 50));
	assert.equal(fs.readFileSync(marker, 'utf-8'), 'ok');
});

test('register_computer_control seeds apps.json and registers an IPC handler', async () => {
	const dir = temp_dir();
	/** @type {Map<string, Function>} */
	const handlers = new Map();
	register_computer_control({
		app: { getPath: () => dir },
		ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) }
	});
	assert.ok(fs.existsSync(path.join(dir, 'apps.json')));
	const handler = handlers.get('computer-control:run');
	assert.ok(handler);
	const result = await handler({}, { action: 'list_apps' });
	assert.equal(result.ok, true);
});
