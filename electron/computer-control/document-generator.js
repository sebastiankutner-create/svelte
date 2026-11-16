import process from 'node:process';

/**
 * Asks Groq to write the document as Markdown. Remembered facts are added to the system
 * prompt, like every other AI call.
 */

export const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

/** Override with the `model` option or `GROQ_DOCUMENT_MODEL`. */
export const DEFAULT_DOCUMENT_MODEL = 'openai/gpt-oss-120b';

const SYSTEM_PROMPT = `You write documents that will be saved as a file for the user. Output Markdown only, with no preamble or sign-off (no "Sure, here is..."), and don't wrap it in a code block.

Structure:
- Start with exactly one level-1 heading (# Title): a short, specific title for the document. It becomes the file name.
- Use ## and ### headings for sections, short paragraphs, bullet lists (- item) and numbered lists (1. item) where they help.
- **Bold** and *italic* are fine. Don't use tables, images, HTML or footnotes.

Write the content the user asked for, at a length that suits it.`;

export class GenerationError extends Error {}

/**
 * @param {{ request: string, format_name: string }} input
 * @param {{
 *   api_key?: string,
 *   model?: string,
 *   fetch?: typeof fetch,
 *   context?: () => string,
 *   timeout_ms?: number
 * }} [options]
 * @returns {Promise<string>} Markdown
 */
export async function generate_markdown({ request, format_name }, options = {}) {
	const api_key = options.api_key ?? process.env.GROQ_API_KEY;
	if (!api_key)
		throw new GenerationError("I can't write documents because no Groq API key is set.");

	const model = options.model ?? process.env.GROQ_DOCUMENT_MODEL ?? DEFAULT_DOCUMENT_MODEL;
	let context = '';
	try {
		context = options.context?.() ?? '';
	} catch {
		// ignore a broken context provider
	}

	/** @type {Response} */
	let response;
	try {
		response = await (options.fetch ?? fetch)(GROQ_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api_key}` },
			body: JSON.stringify({
				model,
				temperature: 0.5,
				max_completion_tokens: 8192,
				messages: [
					{ role: 'system', content: [SYSTEM_PROMPT, context].filter(Boolean).join('\n\n') },
					{ role: 'user', content: `Write a ${format_name} about: ${request}` }
				]
			}),
			signal: AbortSignal.timeout(options.timeout_ms ?? 120_000)
		});
	} catch (e) {
		const name = /** @type {Error} */ (e)?.name;
		throw new GenerationError(
			name === 'TimeoutError'
				? 'Writing the document took too long.'
				: `I couldn't reach Groq: ${/** @type {Error} */ (e).message}`
		);
	}

	/** @type {any} */
	const json = await response.json().catch(() => null);
	if (!response.ok) {
		const detail = json?.error?.message ?? `HTTP ${response.status}`;
		if (response.status === 401) throw new GenerationError('Groq rejected the API key.');
		if (response.status === 429)
			throw new GenerationError("Groq says we're rate limited. Try again in a minute.");
		throw new GenerationError(`Groq couldn't write the document: ${detail}`);
	}

	const text = json?.choices?.[0]?.message?.content;
	if (typeof text !== 'string' || text.trim() === '')
		throw new GenerationError('The model came back with an empty document.');
	return text;
}
