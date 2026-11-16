import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

/**
 * Crash-safe JSON persistence for the assistant's memory.
 *
 * Every save:
 *   1. writes the new data to `memory.json.<pid>.tmp` and fsyncs it,
 *   2. copies the current `memory.json` (if it is valid) to `memory.json.bak` (also tmp + rename),
 *   3. renames the tmp file over `memory.json` (atomic on the same volume).
 * So at any instant `memory.json` is either the old or the new version, never half-written,
 * and `memory.json.bak` holds the previous good version as a fallback.
 */

export const MEMORY_FILE = 'memory.json';
export const BACKUP_FILE = 'memory.json.bak';
export const SCHEMA_VERSION = 1;

/**
 * @typedef {{ role: 'user' | 'assistant', content: string, at: string }} Message
 * @typedef {{ id: string, text: string, created_at: string, updated_at: string }} Fact
 * @typedef {{ version: number, updated_at: string | null, conversation: Message[], facts: Fact[] }} MemoryData
 */

/**
 * A fixed location that doesn't depend on how the app was launched: `~/.tars`
 * (e.g. `C:\Users\you\.tars` on Windows), or `TARS_MEMORY_DIR` if set.
 */
export function default_memory_dir() {
	return process.env.TARS_MEMORY_DIR || path.join(os.homedir(), '.tars');
}

/** @returns {MemoryData} */
export function empty_memory() {
	return { version: SCHEMA_VERSION, updated_at: null, conversation: [], facts: [] };
}

/**
 * @typedef {object} ReadResult
 * @property {MemoryData} data
 * @property {'main' | 'backup' | 'empty'} source
 * @property {string} [warning]
 */

/**
 * Load `memory.json`, falling back to the backup. A file that can't be parsed is moved
 * aside as `*.corrupt-<timestamp>` (never deleted) so the next save can't overwrite the
 * good backup with it.
 *
 * @param {string} dir
 * @returns {ReadResult}
 */
export function read_memory(dir) {
	const main = path.join(dir, MEMORY_FILE);
	const backup = path.join(dir, BACKUP_FILE);
	/** @type {string[]} */
	const problems = [];

	for (const [file, source] of /** @type {const} */ ([
		[main, 'main'],
		[backup, 'backup']
	])) {
		if (!fs.existsSync(file)) continue;
		try {
			const data = normalise(JSON.parse(fs.readFileSync(file, 'utf-8')));
			if (source === 'backup') {
				// restore it as the main file so the next save backs up good data
				write_file_atomic(main, JSON.stringify(data, null, '\t'));
			}
			return {
				data,
				source,
				warning:
					problems.length > 0
						? `${problems.join('; ')}; restored from ${path.basename(file)}`
						: undefined
			};
		} catch (e) {
			const aside = `${file}.corrupt-${Date.now()}`;
			try {
				fs.renameSync(file, aside);
			} catch {
				// leave it where it is
			}
			problems.push(
				`${path.basename(file)} was unreadable (${/** @type {Error} */ (e).message}), kept as ${path.basename(aside)}`
			);
		}
	}

	return {
		data: empty_memory(),
		source: 'empty',
		warning: problems.length > 0 ? problems.join('; ') : undefined
	};
}

/**
 * Save synchronously: tmp → fsync → backup current → rename.
 * @param {string} dir
 * @param {MemoryData} data
 */
export function write_memory(dir, data) {
	fs.mkdirSync(dir, { recursive: true });
	const main = path.join(dir, MEMORY_FILE);
	const tmp = `${main}.${process.pid}.tmp`;

	write_and_sync(tmp, JSON.stringify(data, null, '\t'));

	// update the backup from the current (pre-save) file, but only if it is valid JSON
	if (fs.existsSync(main) && is_valid_json_file(main)) {
		const backup_tmp = `${path.join(dir, BACKUP_FILE)}.${process.pid}.tmp`;
		fs.copyFileSync(main, backup_tmp);
		sync_file(backup_tmp);
		rename_with_retry(backup_tmp, path.join(dir, BACKUP_FILE));
	}

	rename_with_retry(tmp, main);
	sync_dir(dir);
}

/**
 * @param {string} file
 * @param {string} contents
 */
function write_file_atomic(file, contents) {
	const tmp = `${file}.${process.pid}.tmp`;
	write_and_sync(tmp, contents);
	rename_with_retry(tmp, file);
	sync_dir(path.dirname(file));
}

/**
 * @param {string} file
 * @param {string} contents
 */
function write_and_sync(file, contents) {
	const fd = fs.openSync(file, 'w');
	try {
		fs.writeFileSync(fd, contents);
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
}

/** @param {string} file */
function sync_file(file) {
	const fd = fs.openSync(file, 'r+');
	try {
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * Persist the rename itself. Not supported on Windows, where rename is already durable enough.
 * @param {string} dir
 */
function sync_dir(dir) {
	if (process.platform === 'win32') return;
	try {
		const fd = fs.openSync(dir, 'r');
		try {
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		// some filesystems don't allow it; the data file itself is already synced
	}
}

/**
 * On Windows, antivirus or the search indexer can briefly hold the target open (EPERM/EBUSY).
 * @param {string} from
 * @param {string} to
 */
function rename_with_retry(from, to) {
	for (let attempt = 0; ; attempt++) {
		try {
			fs.renameSync(from, to);
			return;
		} catch (e) {
			const code = /** @type {NodeJS.ErrnoException} */ (e).code;
			if (attempt >= 5 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw e;
			// short synchronous back-off: this also runs during shutdown, where we can't await
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
		}
	}
}

/** @param {string} file */
function is_valid_json_file(file) {
	try {
		JSON.parse(fs.readFileSync(file, 'utf-8'));
		return true;
	} catch {
		return false;
	}
}

/**
 * @param {any} raw
 * @returns {MemoryData}
 */
function normalise(raw) {
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
		throw new Error('not a memory object');
	const data = empty_memory();
	data.updated_at = typeof raw.updated_at === 'string' ? raw.updated_at : null;
	if (Array.isArray(raw.conversation)) {
		data.conversation = raw.conversation.filter(
			(/** @type {any} */ m) =>
				m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'
		);
	}
	if (Array.isArray(raw.facts)) {
		data.facts = raw.facts.filter(
			(/** @type {any} */ f) => f && typeof f.id === 'string' && typeof f.text === 'string'
		);
	}
	return data;
}
