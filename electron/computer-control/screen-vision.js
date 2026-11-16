import process from 'node:process';
import { capture_all_screens, ScreenCaptureError } from './screen-capture.js';

/** @import { CaptureDeps, Screenshot } from './screen-capture.js' */

export const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

/**
 * Groq retired `llama-3.2-11b-vision-preview`; Llama 4 Scout is its listed replacement.
 * Override with the `model` option or the `GROQ_VISION_MODEL` environment variable.
 */
export const DEFAULT_VISION_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';

export const TARS_PERSONA = `You are TARS, the user's desktop assistant. You have a dry, deadpan sense of humour (humour setting: about 75 percent), you're blunt and honest, quietly loyal, and economical with words. You speak in the first person, like a sharp colleague glancing over the user's shoulder, never like a report generator.

Everything you say is read aloud by text-to-speech, so: no markdown, no bullet points or numbered lists, no headings, no emoji, and don't read out long URLs, file paths or code verbatim; paraphrase them.`;

const DESCRIBE_TASK = `Here is what's on the user's screen right now. Tell them what you see, in your own voice. Keep it to two to five spoken sentences. Lead with what they seem to be doing, then mention anything that actually matters, like an error, a warning, an unread message or something that looks off. Skip trivia like the clock or the taskbar unless it's relevant. Don't enumerate every window. A single dry aside is fine; don't overdo it.`;

/**
 * @param {string} question
 */
const ANSWER_TASK = (question) =>
	`The user is looking at their screen and asked: "${question}"

Answer that directly, using the screenshot as context. Don't describe the screen first and don't recap what's visible beyond what the answer needs. If the screenshot doesn't contain enough to answer, say so in a sentence and say what you'd need. Keep it short enough to say out loud comfortably.`;

/**
 * @typedef {object} VisionOptions
 * @property {string} [api_key] Defaults to `process.env.GROQ_API_KEY`.
 * @property {string} [model] Defaults to `process.env.GROQ_VISION_MODEL`, then {@link DEFAULT_VISION_MODEL}.
 * @property {string} [persona] System prompt describing the assistant's voice. Defaults to {@link TARS_PERSONA}.
 * @property {typeof fetch} [fetch]
 * @property {number} [timeout_ms]
 */

export class VisionError extends Error {}

/**
 * Send screenshots to the Groq vision model and return the reply text.
 *
 * @param {Screenshot[]} shots
 * @param {string | null} question `null` to describe the screen, otherwise the user's question.
 * @param {VisionOptions} [options]
 */
export async function ask_vision_model(shots, question, options = {}) {
	const api_key = options.api_key ?? process.env.GROQ_API_KEY;
	if (!api_key) {
		throw new VisionError(
			"I can't analyze the screen because no Groq API key is set. Add GROQ_API_KEY and restart me."
		);
	}

	const model = options.model ?? process.env.GROQ_VISION_MODEL ?? DEFAULT_VISION_MODEL;
	const do_fetch = options.fetch ?? fetch;

	const layout =
		shots.length > 1
			? `\n\nThere are ${shots.length} screenshots, one per monitor, in this order: ${shots.map((s) => s.label).join(', ')}. Treat them as one desktop.`
			: '';

	const body = {
		model,
		temperature: 0.7,
		max_completion_tokens: 400,
		messages: [
			{ role: 'system', content: options.persona ?? TARS_PERSONA },
			{
				role: 'user',
				content: [
					{ type: 'text', text: (question ? ANSWER_TASK(question) : DESCRIBE_TASK) + layout },
					...shots.map((s) => ({ type: 'image_url', image_url: { url: s.data_url } }))
				]
			}
		]
	};

	/** @type {Response} */
	let response;
	try {
		response = await do_fetch(GROQ_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api_key}` },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(options.timeout_ms ?? 45_000)
		});
	} catch (e) {
		const timed_out = /** @type {Error} */ (e).name === 'TimeoutError';
		throw new VisionError(
			timed_out
				? 'The vision model took too long to answer. Try again in a moment.'
				: `I couldn't reach Groq: ${/** @type {Error} */ (e).message}`
		);
	}

	/** @type {any} */
	let json = null;
	try {
		json = await response.json();
	} catch {
		// handled below
	}

	if (!response.ok) {
		const detail = json?.error?.message ?? `HTTP ${response.status}`;
		const code = json?.error?.code;
		if (code === 'model_decommissioned' || code === 'model_not_found') {
			throw new VisionError(
				`The vision model "${model}" isn't available on Groq any more (${detail}). Set GROQ_VISION_MODEL to a current vision model.`
			);
		}
		if (response.status === 401)
			throw new VisionError('Groq rejected the API key. Check GROQ_API_KEY.');
		if (response.status === 429)
			throw new VisionError("Groq says we're rate limited. Give it a minute.");
		throw new VisionError(`Groq returned an error: ${detail}`);
	}

	const text = json?.choices?.[0]?.message?.content;
	if (typeof text !== 'string' || text.trim() === '') {
		throw new VisionError('The vision model came back with nothing to say.');
	}
	return for_speech(text);
}

/**
 * Strip markdown the model may still produce, so text-to-speech doesn't read "asterisk".
 * @param {string} text
 */
export function for_speech(text) {
	return text
		.replace(/```[\s\S]*?```/g, ' ')
		.replace(/`([^`]*)`/g, '$1')
		.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
		.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
		.replace(/^\s{0,3}#{1,6}\s+/gm, '')
		.replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, '')
		.replace(/(\*\*|__|\*|_)(\S(?:[\s\S]*?\S)?)\1/g, '$2')
		.replace(/\s*\n+\s*/g, ' ')
		.replace(/\s{2,}/g, ' ')
		.trim();
}

/**
 * @typedef {VisionOptions & {
 *   capture: CaptureDeps,
 *   speak?: (text: string) => unknown
 * }} ScreenAnalyzerOptions
 */

/**
 * @typedef {{ ok: true, text: string, question: string | null, screens: number } | { ok: false, error: string }} AnalyzeResult
 */

/**
 * Capture → vision model → voice. Never touches any window, so it works the same when the
 * assistant is minimized; the answer (or a short spoken error) goes to `speak` only.
 *
 * @param {ScreenAnalyzerOptions} options
 */
export function create_screen_analyzer(options) {
	const { capture, speak = () => {}, ...vision } = options;

	/** @type {Promise<AnalyzeResult> | null} */
	let in_flight = null;

	/**
	 * @param {string | null} question
	 * @returns {Promise<AnalyzeResult>}
	 */
	async function analyze(question) {
		if (in_flight) {
			const text = "Hang on, I'm still looking at your screen.";
			await say(text);
			return { ok: false, error: text };
		}

		in_flight = (async () => {
			try {
				const shots = await capture_all_screens(capture);
				const text = await ask_vision_model(shots, question, vision);
				await say(text);
				return /** @type {AnalyzeResult} */ ({ ok: true, text, question, screens: shots.length });
			} catch (e) {
				const known = e instanceof ScreenCaptureError || e instanceof VisionError;
				const error = known
					? /** @type {Error} */ (e).message
					: `Something went wrong while looking at your screen: ${/** @type {Error} */ (e)?.message ?? e}`;
				await say(error);
				return /** @type {AnalyzeResult} */ ({ ok: false, error });
			}
		})();

		try {
			return await in_flight;
		} finally {
			in_flight = null;
		}
	}

	/** @param {string} text */
	async function say(text) {
		try {
			await speak(text);
		} catch {
			// a broken TTS pipeline must not turn into an unhandled rejection in the main process
		}
	}

	return { analyze };
}
