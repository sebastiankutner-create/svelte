import process from 'node:process';

/**
 * The mission log: a running list of notable events (mostly failures) from the main
 * process, shown in the assistant window. Entries are kept in memory so a window that
 * opens or reloads later can still show what happened before it was listening.
 */

export const MISSION_LOG_CHANNEL = 'assistant:mission-log';
export const MISSION_LOG_HISTORY_CHANNEL = 'mission-log:history';

/**
 * @typedef {'error' | 'warn' | 'info'} LogLevel
 *
 * @typedef {object} LogInput
 * @property {LogLevel} level
 * @property {string} source e.g. `"memory"`
 * @property {string} event Machine-readable kind, e.g. `"extraction_failed"`
 * @property {string} message One readable line for the log panel.
 * @property {Record<string, unknown>} [detail] Extra fields (status codes, timings, ids...).
 *
 * @typedef {LogInput & { id: number, at: string }} LogEntry
 *
 * @typedef {(entry: LogInput) => void} Logger
 */

/**
 * @param {{
 *   get_window?: () => { isDestroyed(): boolean, webContents: { send(channel: string, ...args: unknown[]): void } } | null | undefined,
 *   max_entries?: number,
 *   print?: (line: string) => void,
 *   now?: () => Date
 * }} [options]
 */
export function create_mission_log(options = {}) {
	const max_entries = options.max_entries ?? 200;
	const print = options.print ?? ((line) => process.stderr.write(`${line}\n`));
	const now = options.now ?? (() => new Date());

	/** @type {LogEntry[]} */
	const entries = [];
	let next_id = 1;

	/** @type {Logger} */
	function log(input) {
		/** @type {LogEntry} */
		const entry = { id: next_id++, at: now().toISOString(), ...input };
		entries.push(entry);
		if (entries.length > max_entries) entries.splice(0, entries.length - max_entries);

		// also in the terminal / main-process log file, in case the window isn't open
		try {
			const detail = entry.detail ? ` ${JSON.stringify(entry.detail)}` : '';
			print(
				`[${entry.at}] ${entry.level.toUpperCase()} ${entry.source}/${entry.event}: ${entry.message}${detail}`
			);
		} catch {
			// logging must never throw into the caller
		}

		try {
			const win = options.get_window?.();
			if (win && !win.isDestroyed()) win.webContents.send(MISSION_LOG_CHANNEL, entry);
		} catch {
			// window is closing; the entry is still in the history
		}
	}

	return {
		log,
		/** @returns {LogEntry[]} */
		entries: () => entries.map((e) => ({ ...e })),
		/**
		 * Let the renderer fetch entries logged before it was listening.
		 * @param {{ handle(channel: string, listener: () => Promise<LogEntry[]>): void }} ipcMain
		 */
		register_ipc(ipcMain) {
			ipcMain.handle(MISSION_LOG_HISTORY_CHANNEL, () =>
				Promise.resolve(entries.map((e) => ({ ...e })))
			);
		}
	};
}

/** @typedef {ReturnType<typeof create_mission_log>} MissionLog */
