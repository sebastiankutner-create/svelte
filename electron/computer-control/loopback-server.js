import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

/**
 * Serves the renderer over http://127.0.0.1:<port>. YouTube embeds refuse to play in pages
 * loaded from file:// (player error 153: the embed gets no usable origin/referrer), so the
 * assistant window must load its UI from a real HTTP origin instead.
 */

const MIME = /** @type {Record<string, string>} */ ({
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.ico': 'image/x-icon',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.mp3': 'audio/mpeg',
	'.wav': 'audio/wav'
});

export const DEFAULT_CSP = [
	"default-src 'self'",
	"script-src 'self'",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data: https://i.ytimg.com",
	"connect-src 'self'",
	"media-src 'self' blob:",
	'frame-src https://www.youtube-nocookie.com',
	"object-src 'none'",
	"base-uri 'none'"
].join('; ');

/**
 * @typedef {object} RendererServer
 * @property {string} url e.g. `http://127.0.0.1:53124/`, pass to `win.loadURL()`
 * @property {string} origin e.g. `http://127.0.0.1:53124`
 * @property {number} port
 * @property {() => Promise<void>} close
 */

/**
 * @param {string} root Directory containing `index.html` and the renderer's files.
 * @param {{ port?: number, csp?: string }} [options] `port: 0` (the default) picks any free port.
 * @returns {Promise<RendererServer>}
 */
export function start_renderer_server(root, options = {}) {
	const base = path.resolve(root);
	const csp = options.csp ?? DEFAULT_CSP;
	/** @type {string} */
	let expected_host = '';

	const server = http.createServer((req, res) => {
		// only answer requests addressed to us by IP: blocks DNS-rebinding pages from reading the UI
		if (req.headers.host !== expected_host) return send(res, 421, 'Misdirected request');
		if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');

		/** @type {string} */
		let pathname;
		try {
			pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
		} catch {
			return send(res, 400, 'Bad request');
		}
		if (pathname.includes('\0')) return send(res, 400, 'Bad request');

		let file = path.resolve(base, '.' + pathname);
		if (file !== base && !file.startsWith(base + path.sep)) return send(res, 403, 'Forbidden');

		try {
			if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
			const body = fs.readFileSync(file);
			res.writeHead(200, {
				'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
				'Content-Length': body.length,
				'Cache-Control': 'no-store',
				'X-Content-Type-Options': 'nosniff',
				// the embed needs to see where it's hosted; never send `no-referrer`
				'Referrer-Policy': 'strict-origin-when-cross-origin',
				'Content-Security-Policy': csp
			});
			res.end(req.method === 'HEAD' ? undefined : body);
		} catch {
			send(res, 404, 'Not found');
		}
	});

	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(options.port ?? 0, '127.0.0.1', () => {
			const address = /** @type {import('node:net').AddressInfo} */ (server.address());
			expected_host = `127.0.0.1:${address.port}`;
			const origin = `http://${expected_host}`;
			resolve({
				url: `${origin}/`,
				origin,
				port: address.port,
				close: () =>
					new Promise((done) => {
						server.closeAllConnections();
						server.close(() => done());
					})
			});
		});
	});
}

/**
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {string} message
 */
function send(res, status, message) {
	res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
	res.end(message);
}

/**
 * @typedef {{
 *   loadURL(url: string): Promise<void>,
 *   once(event: 'closed', listener: () => void): unknown,
 *   webContents: {
 *     on(event: 'will-navigate' | 'will-redirect', listener: (event: { url?: string, preventDefault(): void }, url?: string) => void): unknown,
 *     setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' } | { action: 'allow' }): void
 *   }
 * }} WindowLike
 */

/**
 * Load the assistant UI into `win` from `http://127.0.0.1:<free port>/` instead of
 * `win.loadFile()` / `file://`. Replaces:
 *
 * ```js
 * win.loadFile('renderer/index.html');                       // before
 * await load_renderer(win, path.join(import.meta.dirname, 'renderer'), {
 *   open_external: (url) => shell.openExternal(url)          // after
 * });
 * ```
 *
 * The window is kept on that origin: navigating anywhere else (including `file://`) is
 * blocked, and web links go to `open_external` (the user's browser) instead. The server stops
 * when the window is closed.
 *
 * @param {WindowLike} win
 * @param {string} root Folder with `index.html`.
 * @param {{ port?: number, csp?: string, open_external?: (url: string) => unknown }} [options]
 * @returns {Promise<RendererServer>}
 */
export async function load_renderer(win, root, options = {}) {
	if (!fs.existsSync(path.join(root, 'index.html'))) {
		throw new Error(`Can't load the assistant UI: there is no index.html in ${path.resolve(root)}`);
	}

	const server = await start_renderer_server(root, options);

	/** @param {string | undefined} url */
	const is_ours = (url) => {
		try {
			return new URL(url ?? '').origin === server.origin;
		} catch {
			return false;
		}
	};
	/** @param {string | undefined} url */
	const open_outside = (url) => {
		if (url && /^https?:\/\//i.test(url)) {
			try {
				options.open_external?.(url);
			} catch {
				// ignore
			}
		}
	};

	/** @param {{ url?: string, preventDefault(): void }} event @param {string} [legacy_url] */
	const guard = (event, legacy_url) => {
		const url = event.url ?? legacy_url;
		if (!is_ours(url)) {
			event.preventDefault();
			open_outside(url);
		}
	};
	win.webContents.on('will-navigate', guard);
	win.webContents.on('will-redirect', guard);
	win.webContents.setWindowOpenHandler(({ url }) => {
		// e.g. "Watch on YouTube" in the embed: open it in the browser, not a new Electron window
		open_outside(url);
		return { action: 'deny' };
	});

	win.once('closed', () => {
		void server.close();
	});

	await win.loadURL(server.url);
	return server;
}
