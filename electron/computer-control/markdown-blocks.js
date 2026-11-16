/**
 * Turns the AI's Markdown into typed blocks that every renderer (PDF, DOCX, plain text)
 * understands. Deliberately small: headings, paragraphs, bullet lists, numbered lists and
 * code blocks, with bold / italic / code / link spans inside them.
 */

/**
 * @typedef {{ text: string, bold?: boolean, italic?: boolean, code?: boolean, link?: string }} Run
 *
 * @typedef {{ level: number, ordered: boolean, number: number | null, runs: Run[] }} ListItem
 *
 * @typedef {{ type: 'heading', level: 1 | 2 | 3 | 4 | 5 | 6, runs: Run[] }
 *   | { type: 'paragraph', runs: Run[] }
 *   | { type: 'bullet_list', items: ListItem[] }
 *   | { type: 'numbered_list', items: ListItem[] }
 *   | { type: 'code', text: string }} Block
 */

const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const SETEXT = /^ {0,3}(=+|-+)\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const BULLET = /^(\s*)[-*+•]\s+(.*)$/;
const NUMBERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const FENCE = /^ {0,3}(```+|~~~+)/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/**
 * @param {string} markdown
 * @returns {Block[]}
 */
export function parse_markdown(markdown) {
	const lines = unwrap(String(markdown ?? ''))
		.replace(/\t/g, '    ')
		.split(/\r?\n/);

	/** @type {Block[]} */
	const blocks = [];
	/** @type {string[]} */
	let paragraph = [];
	/** @type {(Block & { type: 'bullet_list' | 'numbered_list' }) | null} */
	let list = null;
	/** numbering per nesting level of the current list */
	/** @type {Array<number | undefined>} */
	let counters = [];
	let blank_before = false;

	const flush_paragraph = () => {
		if (paragraph.length > 0)
			blocks.push({ type: 'paragraph', runs: parse_inline(paragraph.join(' ')) });
		paragraph = [];
	};
	const close_list = () => {
		list = null;
		counters = [];
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		if (line.trim() === '') {
			flush_paragraph();
			blank_before = true;
			continue;
		}

		const fence = FENCE.exec(line);
		if (fence) {
			flush_paragraph();
			close_list();
			const code = [];
			while (++i < lines.length && !lines[i].trimStart().startsWith(fence[1])) code.push(lines[i]);
			blocks.push({ type: 'code', text: code.join('\n') });
			blank_before = false;
			continue;
		}

		const heading = HEADING.exec(line);
		if (heading) {
			flush_paragraph();
			close_list();
			const level = /** @type {1 | 2 | 3 | 4 | 5 | 6} */ (heading[1].length);
			blocks.push({ type: 'heading', level, runs: parse_inline(heading[2]) });
			blank_before = false;
			continue;
		}

		// "Title\n=====" / "Section\n-------"
		const setext = paragraph.length === 1 && !list ? SETEXT.exec(line) : null;
		if (setext) {
			blocks.push({
				type: 'heading',
				level: setext[1][0] === '=' ? 1 : 2,
				runs: parse_inline(paragraph[0])
			});
			paragraph = [];
			continue;
		}

		if (RULE.test(line)) {
			flush_paragraph();
			close_list();
			continue;
		}

		const bullet = BULLET.exec(line);
		const numbered = bullet ? null : NUMBERED.exec(line);
		if (bullet || numbered) {
			flush_paragraph();
			const ordered = !!numbered;
			const indent = (bullet ?? /** @type {RegExpExecArray} */ (numbered))[1].length;
			const level = Math.min(Math.floor(indent / 2), 4);
			const text = bullet ? bullet[2] : /** @type {RegExpExecArray} */ (numbered)[3];

			// a top-level item of the other kind starts a new list
			const type = ordered ? 'numbered_list' : 'bullet_list';
			if (!list || (level === 0 && list.type !== type)) {
				close_list();
				/** @type {Block & { type: 'bullet_list' | 'numbered_list' }} */
				const created = { type, items: [] };
				blocks.push(created);
				list = created;
			}
			const current = /** @type {Block & { type: 'bullet_list' | 'numbered_list' }} */ (list);

			counters.length = level + 1;
			let number = null;
			if (ordered) {
				counters[level] =
					counters[level] === undefined
						? Number(/** @type {RegExpExecArray} */ (numbered)[2])
						: /** @type {number} */ (counters[level]) + 1;
				number = /** @type {number} */ (counters[level]);
			} else {
				counters[level] = undefined;
			}

			current.items.push({ level, ordered, number, runs: parse_inline(text) });
			blank_before = false;
			continue;
		}

		// indented line right after a list item continues that item
		if (list && !blank_before && /^\s{2,}\S/.test(line)) {
			const item = list.items[list.items.length - 1];
			item.runs = parse_inline(`${runs_to_markdown(item.runs)} ${line.trim()}`);
			continue;
		}

		if (TABLE_ROW.test(line)) {
			flush_paragraph();
			close_list();
			if (!TABLE_DIVIDER.test(line)) {
				const cells = line
					.trim()
					.replace(/^\||\|$/g, '')
					.split('|')
					.map((c) => c.trim());
				blocks.push({ type: 'paragraph', runs: parse_inline(cells.join(' | ')) });
			}
			continue;
		}

		const quote = QUOTE.exec(line);
		const text = quote ? quote[1] : line.trim();

		// any other unindented text ends the list
		close_list();
		paragraph.push(text);
		blank_before = false;
	}

	flush_paragraph();
	return blocks.filter(
		(b) =>
			b.type === 'code' || b.type.endsWith('list') || plain_text(/** @type {any} */ (b).runs) !== ''
	);
}

/**
 * The AI often wraps its whole answer in ```markdown ... ``` and adds a chatty first line.
 * @param {string} markdown
 */
function unwrap(markdown) {
	const trimmed = markdown.trim();
	const wrapped = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i.exec(trimmed);
	return wrapped ? wrapped[1] : trimmed;
}

/**
 * Inline Markdown → runs. Handles **bold**, __bold__, *italic*, _italic_, `code`,
 * [text](url), <https://autolinks> and backslash escapes.
 *
 * @param {string} text
 * @returns {Run[]}
 */
export function parse_inline(text) {
	/** @type {Run[]} */
	const runs = [];
	let bold = false;
	let italic = false;
	let buffer = '';

	const push = (/** @type {Run} */ run) => {
		if (!run.text) return;
		const last = runs[runs.length - 1];
		if (
			last &&
			!last.code &&
			!run.code &&
			!last.link &&
			!run.link &&
			!!last.bold === !!run.bold &&
			!!last.italic === !!run.italic
		) {
			last.text += run.text;
		} else {
			runs.push(run);
		}
	};
	const flush = () => {
		push(style({ text: buffer }));
		buffer = '';
	};
	const style = (/** @type {Run} */ run) => ({
		...run,
		...(bold ? { bold: true } : {}),
		...(italic ? { italic: true } : {})
	});

	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		const rest = text.slice(i);

		if (c === '\\' && i + 1 < text.length && /[\\`*_{}[\]()#+\-.!|>~]/.test(text[i + 1])) {
			buffer += text[++i];
			continue;
		}

		if (c === '`') {
			const end = text.indexOf('`', i + 1);
			if (end !== -1) {
				flush();
				push(style({ text: text.slice(i + 1, end), code: true }));
				i = end;
				continue;
			}
		}

		const link = /^\[([^\]]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/.exec(rest);
		if (link) {
			flush();
			const inner = parse_inline(link[1]);
			for (const run of inner)
				push({ ...style(run), ...(safe_url(link[2]) ? { link: link[2] } : {}) });
			i += link[0].length - 1;
			continue;
		}

		const auto = /^<(https?:\/\/[^>\s]+)>/.exec(rest);
		if (auto) {
			flush();
			push(style({ text: auto[1], link: auto[1] }));
			i += auto[0].length - 1;
			continue;
		}

		const strong = /^(\*\*|__)/.exec(rest);
		if (strong) {
			if (bold || text.indexOf(strong[1], i + 2) !== -1) {
				flush();
				bold = !bold;
			} else {
				// no closing marker: keep it as text
				buffer += strong[1];
			}
			i += 1;
			continue;
		}

		if ((c === '*' || c === '_') && (italic || can_open_emphasis(text, i))) {
			// `_` inside words (snake_case) and `*` between digits (2*3*4) are literal
			const before = text[i - 1] ?? '';
			const after = text[i + 1] ?? '';
			const intraword =
				(c === '_' && /\w/.test(before) && /\w/.test(after)) ||
				(c === '*' && /\d/.test(before) && /\d/.test(after));
			if (!intraword) {
				flush();
				italic = !italic;
				continue;
			}
		}

		buffer += c;
	}
	flush();

	return runs;
}

/**
 * @param {string} text
 * @param {number} i
 */
function can_open_emphasis(text, i) {
	const c = text[i];
	if (/\s/.test(text[i + 1] ?? ' ')) return false;
	for (let j = i + 1; j < text.length; j++) {
		if (text[j] === c && text[j + 1] !== c && !/\s/.test(text[j - 1])) return true;
	}
	return false;
}

/** @param {string} url */
function safe_url(url) {
	return /^(https?:|mailto:)/i.test(url);
}

/**
 * @param {Run[] | undefined} runs
 */
export function plain_text(runs) {
	return (runs ?? [])
		.map((r) => r.text)
		.join('')
		.replace(/\s+/g, ' ')
		.trim();
}

/** @param {Run[]} runs */
function runs_to_markdown(runs) {
	return runs
		.map((r) => {
			let t = r.code ? `\`${r.text}\`` : r.text;
			if (r.italic) t = `*${t}*`;
			if (r.bold) t = `**${t}**`;
			if (r.link) t = `[${t}](${r.link})`;
			return t;
		})
		.join('');
}

/**
 * The text of the first level-1 heading, if any.
 * @param {Block[]} blocks
 */
export function first_h1(blocks) {
	const heading = blocks.find((b) => b.type === 'heading' && b.level === 1);
	return heading && heading.type === 'heading' ? plain_text(heading.runs) : null;
}
