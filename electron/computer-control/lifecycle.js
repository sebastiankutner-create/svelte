import process from 'node:process';

/** @import { Memory } from './memory.js' */

/**
 * @typedef {{
 *   isDestroyed(): boolean,
 *   isMinimized(): boolean,
 *   restore(): void,
 *   isVisible(): boolean,
 *   show(): void,
 *   focus(): void,
 *   moveTop?(): void
 * }} WindowLike
 */

/**
 * Make this the only running instance. Call it first thing in the main process, before
 * creating windows or opening memory: a second launch quits immediately (and never
 * touches the memory file), and the running instance brings its window forward instead.
 *
 * @param {{
 *   requestSingleInstanceLock(): boolean,
 *   quit(): void,
 *   on(event: 'second-instance', listener: () => void): unknown,
 *   focus?(options?: { steal: boolean }): void
 * }} app
 * @param {() => WindowLike | null | undefined} get_window
 * @returns {boolean} `false` in a second instance: return straight away without doing anything else.
 */
export function claim_single_instance(app, get_window) {
	if (!app.requestSingleInstanceLock()) {
		app.quit();
		return false;
	}

	app.on('second-instance', () => {
		const win = get_window();
		if (!win || win.isDestroyed()) return;
		if (win.isMinimized()) win.restore();
		if (!win.isVisible()) win.show();
		win.moveTop?.();
		win.focus();
		app.focus?.({ steal: true });
	});

	return true;
}

/**
 * Save memory immediately (synchronously) whenever the app is going away, instead of
 * trusting a debounce timer to fire in time.
 *
 * @param {{
 *   app: { on(event: string, listener: (...args: any[]) => void): unknown, quit(): void },
 *   memory: Pick<Memory, 'flush' | 'close'>,
 *   powerMonitor?: { on(event: 'shutdown', listener: () => void): unknown }
 * }} options
 */
export function save_memory_on_exit({ app, memory, powerMonitor }) {
	const flush = () => memory.flush();

	// quitting normally: Cmd+Q, app.quit(), last window closed
	app.on('before-quit', flush);
	app.on('will-quit', () => memory.close());

	// windows closing, and Windows log-off / shutdown (which may skip before-quit)
	app.on('browser-window-created', (/** @type {unknown} */ _event, /** @type {any} */ win) => {
		win.on('close', flush);
		win.on('session-end', flush);
	});

	// macOS / Linux shutdown
	powerMonitor?.on('shutdown', flush);

	// Ctrl+C in a terminal, kill, or a crash on the way out
	for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM', 'SIGHUP'])) {
		process.once(signal, () => {
			flush();
			app.quit();
		});
	}
	process.on('exit', flush);
}
