import process from 'node:process';
import { default_memory_dir, read_memory, write_memory } from './memory-store.js';

/** @import { Fact, MemoryData, Message } from './memory-store.js' */

export const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

/**
 * Groq retired llama-3.1-8b-instant and llama-3.3-70b-versatile in 2026; GPT-OSS 20B is a
 * cheap current model that supports JSON mode. Override with `model` or `GROQ_MEMORY_MODEL`.
 */
export const DEFAULT_MEMORY_MODEL = 'openai/gpt-oss-20b';

export const MAX_FACTS = 300;
const MAX_FACT_LENGTH = 300;
const MAX_NEW_FACTS_PER_TURN = 5;

const EXTRACT_PROMPT = `You maintain the long-term memory of a personal voice assistant. You will get the facts already remembered about the user and the latest exchange between the user and the assistant. Decide whether the exchange contains anything worth remembering for future conversations.

Remember durable things the USER said or confirmed about themselves or their life: name, pronouns, family, friends, pets, coworkers, where they live or work, job, projects, tools they use, preferences and dislikes, routines, goals, important dates, and how they like the assistant to behave.

Do NOT remember: one-off requests ("open Chrome", "play a video"), what is on their screen right now, the weather, small talk, anything the assistant said that the user didn't confirm, guesses, or secrets such as passwords, API keys, card or account numbers, or health details the user didn't ask you to keep.

Write each fact as one short third-person sentence, e.g. "The user's sister is called Maya." If the exchange corrects or changes a remembered fact, update it instead of adding a new one. If the user asks you to forget something, remove it. Never duplicate an existing fact.

Reply with JSON only, in exactly this shape:
{"add": ["new fact", ...], "update": [{"id": "<existing id>", "text": "corrected fact"}], "remove": ["<existing id>", ...]}
Use empty arrays when there is nothing to change, which is the usual case.`;

/**
 * @typedef {object} MemoryOptions
 * @property {string} [dir] Folder for `memory.json`. Defaults to {@link default_memory_dir}.
 * @property {number} [debounce_ms] Delay before a routine save. `flush()` skips it.
 * @property {string} [api_key] Defaults to `process.env.GROQ_API_KEY`. Without a key, facts aren't extracted.
 * @property {string} [model] Defaults to `process.env.GROQ_MEMORY_MODEL`, then {@link DEFAULT_MEMORY_MODEL}.
 * @property {typeof fetch} [fetch]
 * @property {number} [timeout_ms]
 * @property {(message: string) => void} [warn]
 * @property {() => Date} [now]
 */

/**
 * @param {MemoryOptions} [options]
 */
export function create_memory(options = {}) {
	const dir = options.dir ?? default_memory_dir();
	const debounce_ms = options.debounce_ms ?? 500;
	const warn = options.warn ?? (() => {});
	const now = options.now ?? (() => new Date());

	const loaded = read_memory(dir);
	if (loaded.warning) warn(`memory: ${loaded.warning}`);

	/** @type {MemoryData} */
	const data = loaded.data;
	let dirty = false;
	/** @type {ReturnType<typeof setTimeout> | null} */
	let timer = null;
	let closed = false;
	/** @type {Promise<void>} extractions run one at a time, in turn order */
	let extraction_chain = Promise.resolve();

	function touch() {
		dirty = true;
		data.updated_at = now().toISOString();
		if (closed) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(save_now, debounce_ms);
		// never keep the process alive just for a pending save
		timer.unref?.();
	}

	function save_now() {
		if (timer) clearTimeout(timer);
		timer = null;
		if (!dirty) return;
		try {
			write_memory(dir, data);
			dirty = false;
		} catch (e) {
			warn(`memory: save failed: ${/** @type {Error} */ (e).message}`);
		}
	}

	/**
	 * Save right now, synchronously, skipping the debounce. Call this on quit: it finishes
	 * before returning, so teardown can't cut it short.
	 */
	function flush() {
		save_now();
	}

	/**
	 * Record one exchange and (unless `extract: false`) start fact extraction in the
	 * background. Returns immediately: it never waits on the network.
	 *
	 * @param {string} user
	 * @param {string} assistant
	 * @param {{ extract?: boolean }} [opts]
	 */
	function record_turn(user, assistant, opts = {}) {
		const at = now().toISOString();
		/** @type {Message[]} */
		const turn = [];
		if (typeof user === 'string' && user.trim()) turn.push({ role: 'user', content: user, at });
		if (typeof assistant === 'string' && assistant.trim())
			turn.push({ role: 'assistant', content: assistant, at });
		if (turn.length === 0) return;

		data.conversation.push(...turn);
		touch();

		if (opts.extract !== false && !closed) {
			// fire-and-forget: errors are logged, never thrown, never awaited by the caller
			extraction_chain = extraction_chain
				.then(() => new Promise((resolve) => setImmediate(resolve)))
				.then(() => extract_facts(user, assistant))
				.catch((e) =>
					warn(`memory: fact extraction failed: ${/** @type {Error} */ (e)?.message ?? e}`)
				);
		}
	}

	/**
	 * @param {string} user
	 * @param {string} assistant
	 */
	async function extract_facts(user, assistant) {
		const api_key = options.api_key ?? process.env.GROQ_API_KEY;
		if (!api_key) return;

		const model = options.model ?? process.env.GROQ_MEMORY_MODEL ?? DEFAULT_MEMORY_MODEL;
		const do_fetch = options.fetch ?? fetch;
		const payload = JSON.stringify({
			known_facts: data.facts.map((f) => ({ id: f.id, text: f.text })),
			exchange: { user, assistant }
		});

		/** @param {boolean} json_mode */
		const request = (json_mode) =>
			do_fetch(GROQ_URL, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api_key}` },
				body: JSON.stringify({
					model,
					temperature: 0.2,
					max_completion_tokens: 1024,
					...(json_mode ? { response_format: { type: 'json_object' } } : {}),
					messages: [
						{ role: 'system', content: EXTRACT_PROMPT },
						{ role: 'user', content: payload }
					]
				}),
				signal: AbortSignal.timeout(options.timeout_ms ?? 30_000)
			});

		let response = await request(true);
		if (response.status === 400) {
			// some models reject JSON mode; the prompt alone asks for JSON
			const body = await response.text().catch(() => '');
			if (/response_format|json/i.test(body)) response = await request(false);
			else throw new Error(`Groq returned 400: ${body.slice(0, 200)}`);
		}
		if (!response.ok) throw new Error(`Groq returned HTTP ${response.status}`);

		const json = /** @type {any} */ (await response.json());
		const text = json?.choices?.[0]?.message?.content;
		if (typeof text !== 'string') return;

		const changes = parse_changes(text);
		if (changes && !closed) apply_changes(changes);
	}

	/**
	 * @param {{ add: string[], update: Array<{ id: string, text: string }>, remove: string[] }} changes
	 */
	function apply_changes(changes) {
		let changed = false;
		const stamp = now().toISOString();

		const removed = new Set(changes.remove);
		if (removed.size > 0) {
			const before = data.facts.length;
			data.facts = data.facts.filter((f) => !removed.has(f.id));
			changed ||= data.facts.length !== before;
		}

		for (const { id, text } of changes.update) {
			const fact = data.facts.find((f) => f.id === id);
			const clean = clean_fact(text);
			if (fact && clean && !has_fact(clean, fact.id)) {
				fact.text = clean;
				fact.updated_at = stamp;
				changed = true;
			}
		}

		for (const text of changes.add.slice(0, MAX_NEW_FACTS_PER_TURN)) {
			const clean = clean_fact(text);
			if (!clean || has_fact(clean)) continue;
			data.facts.push({ id: new_id(), text: clean, created_at: stamp, updated_at: stamp });
			changed = true;
		}

		if (data.facts.length > MAX_FACTS) {
			// drop the least recently touched facts
			data.facts.sort((a, b) => a.updated_at.localeCompare(b.updated_at));
			data.facts.splice(0, data.facts.length - MAX_FACTS);
		}

		if (changed) touch();
	}

	/**
	 * @param {string} text
	 * @param {string} [except_id]
	 */
	function has_fact(text, except_id) {
		const key = fact_key(text);
		return data.facts.some((f) => f.id !== except_id && fact_key(f.text) === key);
	}

	function new_id() {
		/** @type {string} */
		let id;
		do id = `f_${Math.random().toString(36).slice(2, 10)}`;
		while (data.facts.some((f) => f.id === id));
		return id;
	}

	/**
	 * The block to put in the system prompt of every AI call. Empty when nothing is remembered.
	 */
	function context_block() {
		if (data.facts.length === 0) return '';
		return (
			"What you remember about the user from earlier conversations. Use it naturally when it's relevant; don't recite it, and if the user says something has changed, believe them:\n" +
			data.facts.map((f) => `- ${f.text}`).join('\n')
		);
	}

	/**
	 * Messages for a chat-completions call: your system prompt plus remembered facts, the most
	 * recent turns of the stored conversation, then the new user message.
	 *
	 * @param {{ system?: string, user: string, history_messages?: number }} input
	 * @returns {Array<{ role: 'system' | 'user' | 'assistant', content: string }>}
	 */
	function build_messages({ system = '', user, history_messages = 20 }) {
		const context = context_block();
		const system_content = [system, context].filter(Boolean).join('\n\n');
		return [
			...(system_content
				? [{ role: /** @type {const} */ ('system'), content: system_content }]
				: []),
			...data.conversation
				.slice(-history_messages)
				.map((m) => ({ role: m.role, content: m.content })),
			{ role: 'user', content: user }
		];
	}

	/** @param {string} id */
	function forget(id) {
		const before = data.facts.length;
		data.facts = data.facts.filter((f) => f.id !== id);
		if (data.facts.length !== before) touch();
		return data.facts.length !== before;
	}

	/** Flush and stop scheduling saves or extractions. Safe to call more than once. */
	function close() {
		flush();
		closed = true;
	}

	return {
		dir,
		record_turn,
		flush,
		close,
		forget,
		context_block,
		build_messages,
		/** @returns {Fact[]} */
		facts: () => data.facts.map((f) => ({ ...f })),
		/** @returns {Message[]} */
		conversation: () => data.conversation.map((m) => ({ ...m })),
		/** Resolves when queued background extractions have finished (for tests and shutdown). */
		idle: () => extraction_chain,
		get dirty() {
			return dirty;
		}
	};
}

/** @typedef {ReturnType<typeof create_memory>} Memory */

/**
 * @param {string} text
 * @returns {{ add: string[], update: Array<{ id: string, text: string }>, remove: string[] } | null}
 */
export function parse_changes(text) {
	/** @type {any} */
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		const match = /\{[\s\S]*\}/.exec(text);
		if (!match) return null;
		try {
			json = JSON.parse(match[0]);
		} catch {
			return null;
		}
	}
	if (json === null || typeof json !== 'object') return null;

	/** @param {unknown} v */
	const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
	return {
		add: strings(json.add),
		update: Array.isArray(json.update)
			? json.update.filter(
					(/** @type {any} */ u) => u && typeof u.id === 'string' && typeof u.text === 'string'
				)
			: [],
		remove: strings(json.remove)
	};
}

/** @param {string} text */
function clean_fact(text) {
	const clean = text
		.replace(/\p{Cc}/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	return clean.length > 0 && clean.length <= MAX_FACT_LENGTH ? clean : null;
}

/** @param {string} text */
function fact_key(text) {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}
