/**
 * Canonical action strings understood by the router. Whatever wording the AI model returns
 * ("open app", "Launch Application", "launch_program", "go to website", ...) is mapped onto
 * exactly one of these, so the router never has to guess and never silently drops a command.
 */
export const ACTIONS = /** @type {const} */ ({
	OPEN_APP: 'open_app',
	OPEN_URL: 'open_url',
	LIST_APPS: 'list_apps',
	ANALYZE_SCREEN: 'analyze_screen'
});

/** @typedef {typeof ACTIONS[keyof typeof ACTIONS]} Action */

const OPEN_VERBS = new Set([
	'open',
	'launch',
	'start',
	'run',
	'execute',
	'exec',
	'load',
	'boot',
	'fire',
	'bring',
	'show',
	'use',
	'new',
	'create',
	'compose'
]);

const APP_NOUNS = new Set([
	'app',
	'apps',
	'application',
	'applications',
	'program',
	'programs',
	'software',
	'exe',
	'tool'
]);

const URL_WORDS = new Set([
	'url',
	'uri',
	'link',
	'website',
	'site',
	'webpage',
	'page',
	'browse',
	'browser',
	'navigate',
	'visit',
	'goto',
	'web'
]);

const SCREEN_WORDS = new Set([
	'screen',
	'screens',
	'screenshot',
	'screenshots',
	'monitor',
	'monitors'
]);

const LIST_VERBS = new Set(['list', 'show', 'get', 'available', 'which', 'what', 'enumerate']);

/**
 * Lower-case, split camelCase / snake_case / kebab-case and drop punctuation.
 * @param {string} value
 * @returns {string[]}
 */
function tokenize(value) {
	return value
		.replace(/([a-z])([A-Z])/g, '$1 $2')
		.toLowerCase()
		.replace(/\bgo\s*to\b/g, 'goto')
		.replace(/\bweb\s*page\b/g, 'webpage')
		.replace(/[^a-z0-9]+/g, ' ')
		.trim()
		.split(' ')
		.filter(Boolean);
}

/**
 * Normalise any action variant returned by the AI to a canonical action string.
 *
 * Returns `null` (never throws) when the input can't be interpreted, so the caller can
 * report a readable "unrecognised action" error instead of dropping the command.
 *
 * @param {unknown} raw
 * @returns {Action | null}
 */
export function canonIntent(raw) {
	if (typeof raw !== 'string') return null;

	const tokens = tokenize(raw);
	if (tokens.length === 0) return null;

	const joined = tokens.join('_');
	for (const action of Object.values(ACTIONS)) {
		if (joined === action) return action;
	}

	const has = (/** @type {Set<string>} */ set) => tokens.some((t) => set.has(t));

	// "analyze my screen", "look at screen", "take screenshot", "what do you see"
	if (has(SCREEN_WORDS) || /\bwhat (?:do|can) you see\b/.test(tokens.join(' '))) {
		return ACTIONS.ANALYZE_SCREEN;
	}

	// "list apps", "show applications", "what apps are available"
	if (has(LIST_VERBS) && has(APP_NOUNS) && !has(URL_WORDS) && !tokens.includes('open')) {
		return ACTIONS.LIST_APPS;
	}

	// "open url", "go to website", "visit site", "navigate", "browse to"
	if (has(URL_WORDS) && !has(APP_NOUNS)) {
		return ACTIONS.OPEN_URL;
	}

	// "open app", "launch application", "start program", "run", "open"
	if (has(OPEN_VERBS) || has(APP_NOUNS)) {
		return ACTIONS.OPEN_APP;
	}

	return null;
}
