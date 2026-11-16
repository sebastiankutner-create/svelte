/**
 * Spoken video commands:
 *
 * - "play a video about black holes" → `{ action: 'play_video', query: 'black holes' }`
 * - "pause the video" → `{ action: 'pause_video' }`
 * - "resume the video" → `{ action: 'resume_video' }`
 * - "set volume to 40" / "set the volume to forty percent" → `{ action: 'set_volume', volume: 40 }`
 */

/** @typedef {{ action: 'play_video', query: string } | { action: 'pause_video' } | { action: 'resume_video' } | { action: 'set_volume', volume: number }} VideoCommand */

const PLAY =
	/\b(?:play|put\s+on|show\s+me|find(?:\s+me)?|search\s+(?:youtube\s+)?for)\s+(?:me\s+)?(?:a|an|the|some)?\s*(?:youtube\s+)?(?:video|clip|vid)s?\s+(?:about|on|of|for|explaining|showing|called|titled|where)\s+(.+)$/i;
const PLAY_ON_YOUTUBE =
	/\b(?:play|put\s+on|search\s+(?:youtube\s+)?for)\s+(.+?)\s+(?:on|from)\s+youtube$/i;
const SEARCH_YOUTUBE =
	/\b(?:search\s+youtube\s+for|youtube\s+search(?:\s+for)?|look\s+up\s+on\s+youtube)\s+(.+)$/i;

const PAUSE =
	/\b(?:pause|stop|hold)\s+(?:the\s+|this\s+|that\s+)?(?:video|clip|youtube|playback)\b|^\s*pause(?:\s+it)?\s*$/i;
const RESUME =
	/\b(?:resume|unpause|continue|restart|play)\s+(?:the\s+|this\s+|that\s+)?(?:video|clip|youtube|playback)\b|^\s*(?:resume|unpause)(?:\s+it)?\s*$/i;
const VOLUME =
	/\b(?:set\s+(?:the\s+)?volume\s+(?:to|at)|(?:turn|change|put)\s+(?:the\s+)?volume\s+(?:up\s+|down\s+)?to|volume\s+(?:to|at)?)\s*(.+?)\s*(?:percent|%)?\s*$/i;

/**
 * @param {unknown} text
 * @returns {VideoCommand | null}
 */
export function parse_video_command(text) {
	if (typeof text !== 'string') return null;
	const input = text
		.replace(/[’‘]/g, "'")
		.trim()
		.replace(/[\s.!?]+$/, '');
	if (!input) return null;

	const volume = VOLUME.exec(input);
	if (volume) {
		const value = parse_volume(volume[1]);
		if (value !== null) return { action: 'set_volume', volume: value };
	}

	for (const pattern of [PLAY, PLAY_ON_YOUTUBE, SEARCH_YOUTUBE]) {
		const match = pattern.exec(input);
		if (match) {
			const query = clean_query(match[1]);
			if (query) return { action: 'play_video', query };
		}
	}

	if (PAUSE.test(input)) return { action: 'pause_video' };
	if (RESUME.test(input)) return { action: 'resume_video' };

	return null;
}

/**
 * @param {string} query
 */
function clean_query(query) {
	return query
		.replace(/^["']|["']$/g, '')
		.replace(/\s+(?:on|from)\s+youtube$/i, '')
		.replace(/\s+(?:please|for me)$/i, '')
		.trim();
}

const UNITS = /** @type {Record<string, number>} */ ({
	zero: 0,
	one: 1,
	two: 2,
	three: 3,
	four: 4,
	five: 5,
	six: 6,
	seven: 7,
	eight: 8,
	nine: 9,
	ten: 10,
	eleven: 11,
	twelve: 12,
	thirteen: 13,
	fourteen: 14,
	fifteen: 15,
	sixteen: 16,
	seventeen: 17,
	eighteen: 18,
	nineteen: 19
});
const TENS = /** @type {Record<string, number>} */ ({
	twenty: 20,
	thirty: 30,
	forty: 40,
	fourty: 40,
	fifty: 50,
	sixty: 60,
	seventy: 70,
	eighty: 80,
	ninety: 90
});

/**
 * Volume from "40", "40%", "forty", "forty five", "a hundred", "max", "half", "mute".
 * Values outside 0–100 are clamped.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
export function parse_volume(value) {
	if (typeof value === 'number') return Number.isFinite(value) ? clamp(value) : null;
	if (typeof value !== 'string') return null;

	const text = value
		.toLowerCase()
		.replace(/percent|%/g, '')
		.replace(/-/g, ' ')
		.trim();
	const digits = /^(-?\d+(?:\.\d+)?)$/.exec(text);
	if (digits) return clamp(Number(digits[1]));

	if (/^(?:max(?:imum)?|full|all the way up|loudest)$/.test(text)) return 100;
	if (/^(?:half(?: way)?|halfway|medium)$/.test(text)) return 50;
	if (/^(?:mute|muted|off|silent|nothing)$/.test(text)) return 0;

	const words = text
		.replace(/\band\b/g, ' ')
		.split(/\s+/)
		.filter((w) => w && w !== 'a');
	if (words.length === 0) return null;
	if (words.length === 1 && (words[0] === 'hundred' || words[0] === 'one hundred')) return 100;
	if (words.join(' ') === 'one hundred' || words.join(' ') === 'hundred') return 100;

	let total = 0;
	for (const word of words) {
		if (word in TENS) total += TENS[word];
		else if (word in UNITS) total += UNITS[word];
		else return null;
	}
	return clamp(total);
}

/**
 * @param {number} n
 */
function clamp(n) {
	return Math.max(0, Math.min(100, Math.round(n)));
}
