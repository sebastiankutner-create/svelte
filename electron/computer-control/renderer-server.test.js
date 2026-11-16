import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load_renderer } from './index.js';

/** A BrowserWindow stand-in that really fetches what it's asked to load. */
function fake_window() {
	const contents = Object.assign(new EventEmitter(), {
		/** @type {((details: { url: string }) => any) | null} */
		open_handler: null,
		setWindowOpenHandler(/** @type {any} */ handler) {
			this.open_handler = handler;
		}
	});
	const win = Object.assign(new EventEmitter(), {
		/** @type {string[]} */
		loaded: [],
		/** @type {{ status: number, type: string | null, body: string } | null} */
		response: null,
		webContents: contents,
		async loadURL(/** @type {string} */ url) {
			this.loaded.push(url);
			const res = await fetch(url);
			this.response = {
				status: res.status,
				type: res.headers.get('content-type'),
				body: await res.text()
			};
		}
	});
	/** @param {string} url */
	const navigate = (url) => {
		let prevented = false;
		contents.emit('will-navigate', { url, preventDefault: () => (prevented = true) });
		return prevented;
	};
	return { win, contents, navigate };
}

const renderer_dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'renderer');

test('the real renderer is loaded from http://127.0.0.1:<port>, not file://', async () => {
	const { win } = fake_window();
	const server = await load_renderer(/** @type {any} */ (win), renderer_dir);
	try {
		assert.equal(win.loaded.length, 1);
		assert.match(win.loaded[0], /^http:\/\/127\.0\.0\.1:\d+\/$/);
		assert.equal(win.loaded[0], server.url);
		assert.equal(win.response?.status, 200);
		assert.equal(win.response?.type, 'text/html; charset=utf-8');
		assert.match(win.response?.body ?? '', /<title>TARS<\/title>/);
		// the page's scripts come from the same server
		for (const file of ['app.js', 'youtube-player.js', 'mission-log-view.js', 'style.css']) {
			assert.equal((await fetch(new URL(file, server.url))).status, 200, file);
		}
	} finally {
		win.emit('closed');
	}
});

test('the window stays on the loopback origin', async () => {
	/** @type {string[]} */
	const opened = [];
	const { win, contents, navigate } = fake_window();
	const server = await load_renderer(/** @type {any} */ (win), renderer_dir, {
		open_external: (url) => opened.push(url)
	});
	try {
		assert.equal(navigate(`${server.origin}/index.html`), false, 'same origin is allowed');
		assert.equal(navigate('file:///C:/Users/me/secret.txt'), true, 'file:// is blocked');
		assert.equal(navigate('https://example.com/'), true, 'other sites are blocked...');
		assert.deepEqual(opened, ['https://example.com/'], '...and opened in the browser instead');
		assert.equal(navigate('http://127.0.0.1:1/'), true, 'another port is another origin');

		// legacy (event, url) signature
		let prevented = false;
		contents.emit(
			'will-redirect',
			{ preventDefault: () => (prevented = true) },
			'https://evil.example/'
		);
		assert.equal(prevented, true);

		// window.open / target=_blank (e.g. "Watch on YouTube") never makes a new Electron window
		assert.deepEqual(
			contents.open_handler?.({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }),
			{ action: 'deny' }
		);
		assert.equal(opened.at(-1), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
		assert.deepEqual(contents.open_handler?.({ url: 'file:///etc/passwd' }), { action: 'deny' });
		assert.equal(opened.includes('file:///etc/passwd'), false);
	} finally {
		win.emit('closed');
	}
});

test('closing the window stops the server', async () => {
	const { win } = fake_window();
	const server = await load_renderer(/** @type {any} */ (win), renderer_dir);
	win.emit('closed');
	await new Promise((r) => setTimeout(r, 20));
	await assert.rejects(fetch(server.url));
});

test('a missing index.html is a readable error, not a blank window', async () => {
	const { win } = fake_window();
	const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'renderer-'));
	await assert.rejects(
		load_renderer(/** @type {any} */ (win), empty),
		/there is no index\.html in/
	);
	assert.deepEqual(win.loaded, []);
});
