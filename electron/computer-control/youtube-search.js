/**
 * YouTube search by scraping the results page (no API key). Runs in the main process,
 * where there's no CORS. `sp=EgIQAQ%3D%3D` is YouTube's "Type: Video" filter, so channels
 * and playlists are excluded; ads and Shorts use other renderer types and are skipped too.
 */

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

const HEADERS = {
	'User-Agent':
		'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
	'Accept-Language': 'en-US,en;q=0.9',
	// skip the EU cookie-consent interstitial, which has no results in it
	Cookie: 'CONSENT=YES+cb; SOCS=CAI'
};

/** @typedef {{ video_id: string, title: string | null }} VideoResult */

/**
 * @param {string} query
 */
export function search_url(query) {
	return `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=EgIQAQ%3D%3D`;
}

export class YouTubeSearchError extends Error {}

/**
 * @param {string} query
 * @param {{ fetch?: typeof fetch, timeout_ms?: number }} [options]
 * @returns {Promise<VideoResult | null>} `null` when the search has no video results
 */
export async function search_youtube(query, options = {}) {
	const do_fetch = options.fetch ?? fetch;

	/** @type {Response} */
	let response;
	try {
		response = await do_fetch(search_url(query), {
			headers: HEADERS,
			signal: AbortSignal.timeout(options.timeout_ms ?? 10_000)
		});
	} catch (e) {
		throw new YouTubeSearchError(`I couldn't reach YouTube: ${/** @type {Error} */ (e).message}`);
	}
	if (!response.ok)
		throw new YouTubeSearchError(`YouTube search failed (HTTP ${response.status}).`);

	return extract_first_video(await response.text());
}

/**
 * Find the first organic video in a results page, from the `ytInitialData` JSON the page
 * embeds. Falls back to the first `"videoId"` in the HTML if YouTube changes the layout.
 *
 * @param {string} html
 * @returns {VideoResult | null}
 */
export function extract_first_video(html) {
	const data = extract_initial_data(html);
	if (data) {
		const found = find_video_renderer(data);
		if (found) return found;
	}

	const match = /"videoRenderer":\{"videoId":"([A-Za-z0-9_-]{11})"/.exec(html);
	return match ? { video_id: match[1], title: null } : null;
}

const MARKERS = [
	'var ytInitialData = ',
	'window["ytInitialData"] = ',
	"window['ytInitialData'] = ",
	'ytInitialData = '
];

/**
 * @param {string} html
 * @returns {unknown}
 */
export function extract_initial_data(html) {
	for (const marker of MARKERS) {
		const at = html.indexOf(marker);
		if (at === -1) continue;
		const start = html.indexOf('{', at + marker.length);
		if (start === -1) continue;
		const end = matching_brace(html, start);
		if (end === -1) continue;
		try {
			return JSON.parse(html.slice(start, end + 1));
		} catch {
			// try the next marker
		}
	}
	return null;
}

/**
 * Index of the `}` closing the object that opens at `start`, honouring JSON strings.
 * @param {string} text
 * @param {number} start
 */
function matching_brace(text, start) {
	let depth = 0;
	let in_string = false;
	for (let i = start; i < text.length; i++) {
		const c = text[i];
		if (in_string) {
			if (c === '\\') i++;
			else if (c === '"') in_string = false;
		} else if (c === '"') {
			in_string = true;
		} else if (c === '{') {
			depth++;
		} else if (c === '}') {
			if (--depth === 0) return i;
		}
	}
	return -1;
}

/**
 * Depth-first, in document order, so the first hit is the first result on the page.
 * @param {unknown} root
 * @returns {VideoResult | null}
 */
function find_video_renderer(root) {
	/** @type {unknown[]} */
	const stack = [root];
	while (stack.length > 0) {
		const node = stack.pop();
		if (node === null || typeof node !== 'object') continue;

		if (!Array.isArray(node)) {
			const renderer = /** @type {any} */ (node).videoRenderer;
			if (renderer && typeof renderer.videoId === 'string' && VIDEO_ID.test(renderer.videoId)) {
				const title = renderer.title?.runs?.[0]?.text ?? renderer.title?.simpleText ?? null;
				return { video_id: renderer.videoId, title: typeof title === 'string' ? title : null };
			}
		}

		const children = Object.values(node);
		for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
	}
	return null;
}

/**
 * @param {unknown} id
 * @returns {id is string}
 */
export function is_video_id(id) {
	return typeof id === 'string' && VIDEO_ID.test(id);
}
