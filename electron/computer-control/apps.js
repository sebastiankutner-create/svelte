import fs from 'node:fs';
import process from 'node:process';
import path from 'node:path';
import { default_apps } from './default-apps.js';
import { default_links, default_vars } from './default-links.js';

/** @import { AppDefinition } from './default-apps.js' */
/** @import { LinkDefinition } from './default-links.js' */

export const APPS_FILE = 'apps.json';

/**
 * @typedef {object} LoadResult
 * @property {AppDefinition[]} apps
 * @property {LinkDefinition[]} links Deep links (phrase → web address).
 * @property {Record<string, string>} vars Values for `{placeholders}` in link URLs.
 * @property {string} file Absolute path to `apps.json`.
 * @property {boolean} seeded Whether the file was created during this call.
 * @property {string} [warning] Set when the file existed but couldn't be (fully) used.
 */

/**
 * Load app and link definitions from `<userData>/apps.json`, seeding it with the defaults
 * on first run. A file written before deep links existed gets the default `links` and
 * `vars` added (nothing else is touched). A broken file is never overwritten — the
 * defaults are used in memory and a warning is returned so the user can fix it.
 *
 * @param {string} user_data_dir Usually `app.getPath('userData')`.
 * @param {NodeJS.Platform} [platform]
 * @returns {LoadResult}
 */
export function load_apps(user_data_dir, platform = process.platform) {
	const file = path.join(user_data_dir, APPS_FILE);

	if (!fs.existsSync(file)) {
		const data = { apps: default_apps(platform), links: default_links(), vars: default_vars() };
		fs.mkdirSync(user_data_dir, { recursive: true });
		write(file, data);
		return { ...data, file, seeded: true };
	}

	/** @type {any} */
	let parsed;
	try {
		parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
		if (Array.isArray(parsed)) parsed = { apps: parsed };
		if (!Array.isArray(parsed?.apps)) throw new Error('expected an "apps" array');
		if (parsed.links !== undefined && !Array.isArray(parsed.links)) {
			throw new Error('"links" must be an array');
		}
	} catch (e) {
		return {
			apps: default_apps(platform),
			links: default_links(),
			vars: default_vars(),
			file,
			seeded: false,
			warning: `Could not read ${file} (${/** @type {Error} */ (e).message}); using built-in defaults until it is fixed`
		};
	}

	if (parsed.links === undefined || parsed.vars === undefined) {
		parsed.links ??= default_links();
		parsed.vars = { ...default_vars(), ...(is_plain_object(parsed.vars) ? parsed.vars : {}) };
		try {
			write(file, parsed);
		} catch {
			// read-only file: still use the defaults in memory
		}
	}

	const apps = parsed.apps.filter(is_valid_app);
	const links = parsed.links.filter(is_valid_link);

	/** @type {Record<string, string>} */
	const vars = {};
	if (is_plain_object(parsed.vars)) {
		for (const [key, value] of Object.entries(parsed.vars)) {
			if (typeof value === 'string') vars[key] = value;
		}
	}

	const problems = [];
	const skipped_apps = parsed.apps.length - apps.length;
	const skipped_links = parsed.links.length - links.length;
	if (skipped_apps > 0) {
		problems.push(
			`${plural(skipped_apps, 'app')} ignored (each needs "id", "name", "path" and an "intents" array)`
		);
	}
	if (skipped_links > 0) {
		problems.push(
			`${plural(skipped_links, 'link')} ignored (each needs "id", "name", "url" and an "intents" array)`
		);
	}

	return {
		apps,
		links,
		vars,
		file,
		seeded: false,
		warning: problems.length > 0 ? `${file}: ${problems.join('; ')}` : undefined
	};
}

/**
 * @param {string} file
 * @param {unknown} data
 */
function write(file, data) {
	fs.writeFileSync(file, JSON.stringify(data, null, '\t') + '\n');
}

/**
 * @param {number} n
 * @param {string} noun
 */
function plural(n, noun) {
	return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function is_plain_object(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} value
 */
function is_string_array(value) {
	return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/**
 * @param {any} link
 * @returns {link is LinkDefinition}
 */
function is_valid_link(link) {
	return (
		is_plain_object(link) &&
		typeof link.id === 'string' &&
		typeof link.name === 'string' &&
		typeof link.url === 'string' &&
		link.url.length > 0 &&
		is_string_array(link.intents) &&
		(link.browser === undefined || typeof link.browser === 'string')
	);
}

/**
 * Fill `{placeholders}` in a link URL from `vars`. A placeholder with no value is removed
 * (along with the path separator before it), so `https://www.instagram.com/{instagram_handle}`
 * becomes `https://www.instagram.com/` until a handle is set.
 *
 * @param {string} url
 * @param {Record<string, string>} vars
 * @returns {{ url: string, missing: string[] }}
 */
export function fill_link(url, vars) {
	/** @type {string[]} */
	const missing = [];
	const filled = url.replace(/\{([a-z0-9_]+)\}/gi, (_, key) => {
		const value = (vars[key] ?? '').trim().replace(/^@/, '');
		if (!value) {
			missing.push(key);
			return '';
		}
		return encodeURIComponent(value);
	});
	return { url: filled, missing };
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
		is_string_array(app.intents) &&
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
 * Find the app (or link) that best matches a natural phrase such as "browse the web",
 * "open google chrome please" or "new Google Doc". An exact match on the id, name or an
 * intent wins; otherwise the longest intent phrase contained (as whole words) in the query
 * wins. On a tie the entry listed first wins.
 *
 * @template {{ id: string, name: string, intents: string[] }} T
 * @param {string} query
 * @param {T[]} apps
 * @returns {T | null}
 */
export function match_app(query, apps) {
	const q = normalise(query);
	if (!q) return null;

	const padded = ` ${q} `;

	/** @type {T | null} */
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
