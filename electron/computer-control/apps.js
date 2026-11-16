import fs from 'node:fs';
import process from 'node:process';
import path from 'node:path';
import { default_apps } from './default-apps.js';

/** @import { AppDefinition } from './default-apps.js' */

export const APPS_FILE = 'apps.json';

/**
 * @typedef {object} LoadResult
 * @property {AppDefinition[]} apps
 * @property {string} file Absolute path to `apps.json`.
 * @property {boolean} seeded Whether the file was created during this call.
 * @property {string} [warning] Set when the file existed but couldn't be used.
 */

/**
 * Load app definitions from `<userData>/apps.json`, seeding it with the platform defaults
 * on first run. A broken file is never overwritten — the defaults are used in memory
 * and a warning is returned so the user can fix it.
 *
 * @param {string} user_data_dir Usually `app.getPath('userData')`.
 * @param {NodeJS.Platform} [platform]
 * @returns {LoadResult}
 */
export function load_apps(user_data_dir, platform = process.platform) {
	const file = path.join(user_data_dir, APPS_FILE);

	if (!fs.existsSync(file)) {
		const apps = default_apps(platform);
		fs.mkdirSync(user_data_dir, { recursive: true });
		fs.writeFileSync(file, JSON.stringify({ apps }, null, '\t') + '\n');
		return { apps, file, seeded: true };
	}

	try {
		const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
		const list = Array.isArray(parsed) ? parsed : parsed?.apps;
		if (!Array.isArray(list)) throw new Error('expected an "apps" array');

		const apps = list.filter(is_valid_app);
		const skipped = list.length - apps.length;

		return {
			apps,
			file,
			seeded: false,
			warning:
				skipped > 0
					? `${skipped} entr${skipped === 1 ? 'y' : 'ies'} in ${file} ignored (each needs "id", "name", "path" and an "intents" array)`
					: undefined
		};
	} catch (e) {
		return {
			apps: default_apps(platform),
			file,
			seeded: false,
			warning: `Could not read ${file} (${/** @type {Error} */ (e).message}); using built-in defaults until it is fixed`
		};
	}
}

/**
 * @param {any} app
 * @returns {app is AppDefinition}
 */
function is_valid_app(app) {
	return (
		app !== null &&
		typeof app === 'object' &&
		typeof app.id === 'string' &&
		typeof app.name === 'string' &&
		typeof app.path === 'string' &&
		app.path.length > 0 &&
		Array.isArray(app.intents) &&
		app.intents.every((/** @type {unknown} */ i) => typeof i === 'string') &&
		(app.args === undefined ||
			(Array.isArray(app.args) &&
				app.args.every((/** @type {unknown} */ a) => typeof a === 'string')))
	);
}

/**
 * @param {string} value
 */
function normalise(value) {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

/**
 * Find the app that best matches a natural phrase such as "browse the web" or
 * "open google chrome please". An exact match on the id, name or an intent wins;
 * otherwise the longest intent phrase contained (as whole words) in the query wins.
 *
 * @param {string} query
 * @param {AppDefinition[]} apps
 * @returns {AppDefinition | null}
 */
export function match_app(query, apps) {
	const q = normalise(query);
	if (!q) return null;

	const padded = ` ${q} `;

	/** @type {AppDefinition | null} */
	let best = null;
	let best_score = 0;

	for (const app of apps) {
		for (const phrase of [app.id, app.name, ...app.intents]) {
			const p = normalise(phrase);
			if (!p) continue;

			let score = 0;
			if (q === p) score = 10_000 + p.length;
			else if (padded.includes(` ${p} `)) score = p.length;

			if (score > best_score) {
				best = app;
				best_score = score;
			}
		}
	}

	return best;
}
