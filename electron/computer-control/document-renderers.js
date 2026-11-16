import fs from 'node:fs';
import os from 'node:os';
import PDFDocument from 'pdfkit';
import {
	AlignmentType,
	Document,
	ExternalHyperlink,
	HeadingLevel,
	LevelFormat,
	Packer,
	Paragraph,
	TextRun
} from 'docx';
import { plain_text } from './markdown-blocks.js';

/** @import { Block, ListItem, Run } from './markdown-blocks.js' */

/**
 * Each renderer writes `blocks` to `file`, which already exists (it was reserved as an empty
 * file so the name can't be taken in the meantime) and is overwritten here.
 *
 * @typedef {(blocks: Block[], file: string, meta: { title: string }) => Promise<void>} Renderer
 */

// ---------------------------------------------------------------- PDF

/** 2 cm on every side of an A4 page (595 × 842 pt). */
export const PDF_MARGIN = 57;

/**
 * Optional TrueType fonts for full Unicode coverage. Without them the built-in Helvetica /
 * Courier are used, which only cover Western European characters.
 *
 * @typedef {{ regular: string, bold: string, italic: string, bold_italic: string, mono?: string }} PdfFonts
 */

/**
 * @param {{ fonts?: PdfFonts }} [options]
 * @returns {Renderer}
 */
export function create_pdf_renderer(options = {}) {
	const custom = options.fonts;

	return async (blocks, file, { title }) => {
		const doc = new PDFDocument({
			size: 'A4',
			margins: { top: PDF_MARGIN, bottom: PDF_MARGIN, left: PDF_MARGIN, right: PDF_MARGIN },
			info: { Title: title, Creator: 'TARS' },
			autoFirstPage: true
		});

		if (custom) {
			doc.registerFont('body', custom.regular);
			doc.registerFont('body-bold', custom.bold);
			doc.registerFont('body-italic', custom.italic);
			doc.registerFont('body-bold-italic', custom.bold_italic);
			if (custom.mono) doc.registerFont('body-mono', custom.mono);
		}
		const FONT = custom
			? {
					regular: 'body',
					bold: 'body-bold',
					italic: 'body-italic',
					bold_italic: 'body-bold-italic',
					mono: custom.mono ? 'body-mono' : 'Courier'
				}
			: {
					regular: 'Helvetica',
					bold: 'Helvetica-Bold',
					italic: 'Helvetica-Oblique',
					bold_italic: 'Helvetica-BoldOblique',
					mono: 'Courier'
				};
		const encode = custom ? (/** @type {string} */ t) => t : to_win_ansi;

		const stream = fs.createWriteStream(file);
		const finished = new Promise((resolve, reject) => {
			stream.on('finish', resolve);
			stream.on('error', reject);
			doc.on('error', reject);
		});
		doc.pipe(stream);

		const left = doc.page.margins.left;
		const width = () => doc.page.width - doc.page.margins.left - doc.page.margins.right;
		const BODY = 11;
		const HEADING_SIZE = [0, 22, 17, 14, 12.5, 11.5, 11];
		const TEXT = '#1a1a1a';

		/** @param {Run} run */
		const font_for = (run) =>
			run.code
				? FONT.mono
				: run.bold && run.italic
					? FONT.bold_italic
					: run.bold
						? FONT.bold
						: run.italic
							? FONT.italic
							: FONT.regular;

		/** Keep at least a couple of lines together at the bottom of a page. */
		/** @param {number} needed */
		const ensure_space = (needed) => {
			if (doc.y + needed > doc.page.height - doc.page.margins.bottom) doc.addPage();
		};

		/**
		 * @param {Run[]} runs
		 * @param {{ x?: number, y?: number, width: number, size: number, gap: number, bold?: boolean }} o
		 */
		const write_runs = (runs, o) => {
			const parts = runs
				.map((r) => ({ ...r, bold: r.bold || o.bold, text: encode(r.text) }))
				.filter((r) => r.text !== '');
			parts.forEach((run, i) => {
				const last = i === parts.length - 1;
				doc
					.font(font_for(run))
					.fontSize(run.code ? o.size - 1 : o.size)
					.fillColor(run.link ? '#1a4fb5' : TEXT);
				/** @type {PDFKit.Mixins.TextOptions} */
				const text_options = {
					width: o.width,
					continued: !last,
					lineGap: 2,
					paragraphGap: last ? o.gap : 0,
					link: run.link ?? null,
					underline: !!run.link
				};
				if (i === 0 && o.x !== undefined) doc.text(run.text, o.x, o.y, text_options);
				else doc.text(run.text, text_options);
			});
			doc.fillColor(TEXT);
		};

		blocks.forEach((block, index) => {
			const first = index === 0;

			if (block.type === 'heading') {
				const size = HEADING_SIZE[block.level];
				if (!first) doc.moveDown(block.level <= 2 ? 0.8 : 0.5);
				ensure_space(size * 3);
				write_runs(block.runs, {
					x: left,
					y: doc.y,
					width: width(),
					size,
					gap: block.level === 1 ? 10 : 5,
					bold: true
				});
			} else if (block.type === 'paragraph') {
				ensure_space(BODY * 2.5);
				write_runs(block.runs, { x: left, y: doc.y, width: width(), size: BODY, gap: 8 });
			} else if (block.type === 'code') {
				ensure_space(BODY * 2.5);
				doc
					.font(FONT.mono)
					.fontSize(BODY - 1.5)
					.fillColor('#333');
				doc.text(encode(block.text), left + 12, doc.y, {
					width: width() - 12,
					lineGap: 1.5,
					paragraphGap: 8
				});
				doc.fillColor(TEXT);
			} else {
				for (const item of block.items) {
					const indent = 18;
					const x = left + item.level * indent;
					ensure_space(BODY * 2.5);
					const y = doc.y;
					doc.font(FONT.regular).fontSize(BODY).fillColor(TEXT);
					doc.text(list_marker(item), x, y, { width: indent, lineBreak: false });
					write_runs(item.runs, {
						x: x + indent,
						y,
						width: width() - (x + indent - left),
						size: BODY,
						gap: 3
					});
				}
				doc.moveDown(0.4);
			}
			doc.x = left;
		});

		doc.end();
		// doc.end() only means pdfkit has finished generating; the file is complete once the
		// write stream has flushed everything to disk
		await finished;
	};
}

/** @param {ListItem} item */
function list_marker(item) {
	if (item.ordered) return `${item.number}.`;
	return item.level % 2 === 0 ? '•' : '–';
}

/** Characters the built-in PDF fonts (WinAnsi encoding) can show, beyond Latin-1. */
const WIN_ANSI_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');
const REPLACEMENTS = /** @type {Record<string, string>} */ ({
	'→': '->',
	'←': '<-',
	'⇒': '=>',
	'↔': '<->',
	'≤': '<=',
	'≥': '>=',
	'≠': '!=',
	'≈': '~',
	'✓': 'v',
	'✔': 'v',
	'✗': 'x',
	'✘': 'x',
	'−': '-',
	'‐': '-',
	'‑': '-',
	'′': "'",
	Ł: 'L',
	ł: 'l',
	Đ: 'D',
	đ: 'd',
	Ħ: 'H',
	ħ: 'h',
	ı: 'i',
	'″': '"',
	' ': ' ',
	'​': ''
});

/**
 * Map text onto what Helvetica/Courier can draw, so unsupported characters don't come out
 * as garbage glyphs. Pass `fonts` to the PDF renderer for full Unicode instead.
 * @param {string} text
 */
export function to_win_ansi(text) {
	let out = '';
	for (const ch of text.normalize('NFC')) {
		const code = /** @type {number} */ (ch.codePointAt(0));
		if (
			code === 10 ||
			(code >= 0x20 && code <= 0x7e) ||
			(code >= 0xa0 && code <= 0xff) ||
			WIN_ANSI_EXTRA.has(ch)
		)
			out += ch;
		else if (ch in REPLACEMENTS) out += REPLACEMENTS[ch];
		else {
			// try the unaccented letter (e.g. "ő" → "o"), otherwise drop it
			const base = ch.normalize('NFD').replace(/\p{M}/gu, '');
			if (base.length === 1 && /** @type {number} */ (base.codePointAt(0)) <= 0xff) out += base;
		}
	}
	return out;
}

// ---------------------------------------------------------------- DOCX

/** @type {Renderer} */
export async function render_docx(blocks, file, { title }) {
	let list_instance = 0;
	/** @type {Paragraph[]} */
	const children = [];

	const HEADINGS = [
		HeadingLevel.HEADING_1,
		HeadingLevel.HEADING_1,
		HeadingLevel.HEADING_2,
		HeadingLevel.HEADING_3,
		HeadingLevel.HEADING_4,
		HeadingLevel.HEADING_5,
		HeadingLevel.HEADING_6
	];

	for (const block of blocks) {
		if (block.type === 'heading') {
			children.push(
				new Paragraph({ heading: HEADINGS[block.level], children: docx_runs(block.runs) })
			);
		} else if (block.type === 'paragraph') {
			children.push(new Paragraph({ children: docx_runs(block.runs), spacing: { after: 160 } }));
		} else if (block.type === 'code') {
			for (const line of block.text.split('\n')) {
				children.push(
					new Paragraph({
						children: [new TextRun({ text: line, font: 'Consolas', size: 19 })],
						spacing: { after: 0 },
						indent: { left: 360 }
					})
				);
			}
			children.push(new Paragraph({ children: [] }));
		} else {
			// each numbered list restarts at 1
			const instance = ++list_instance;
			for (const item of block.items) {
				children.push(
					new Paragraph({
						children: docx_runs(item.runs),
						...(item.ordered
							? { numbering: { reference: 'numbered', level: item.level, instance } }
							: { bullet: { level: item.level } }),
						spacing: { after: 60 }
					})
				);
			}
			children.push(new Paragraph({ children: [], spacing: { after: 60 } }));
		}
	}

	const doc = new Document({
		title,
		creator: 'TARS',
		styles: {
			default: { document: { run: { font: 'Calibri', size: 22 } } }
		},
		numbering: {
			config: [
				{
					reference: 'numbered',
					levels: [0, 1, 2, 3, 4].map((level) => ({
						level,
						format: [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN][
							level % 3
						],
						text: `%${level + 1}.`,
						alignment: AlignmentType.START,
						style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } }
					}))
				}
			]
		},
		sections: [{ children }]
	});

	fs.writeFileSync(file, await Packer.toBuffer(doc));
}

/**
 * @param {Run[]} runs
 * @returns {Array<TextRun | ExternalHyperlink>}
 */
function docx_runs(runs) {
	return runs.map((run) => {
		const text_run = new TextRun({
			text: run.text,
			bold: run.bold,
			italics: run.italic,
			...(run.code ? { font: 'Consolas' } : {}),
			...(run.link ? { style: 'Hyperlink' } : {})
		});
		return run.link ? new ExternalHyperlink({ link: run.link, children: [text_run] }) : text_run;
	});
}

// ---------------------------------------------------------------- plain text

/**
 * @param {Block[]} blocks
 * @param {string} [eol]
 */
export function blocks_to_text(blocks, eol = os.EOL) {
	/** @type {string[]} */
	const out = [];

	/** @param {Run[]} runs */
	const text = (runs) =>
		runs
			.map((r) => (r.link && r.link !== r.text ? `${r.text} (${r.link})` : r.text))
			.join('')
			.replace(/\s+/g, ' ')
			.trim();

	for (const block of blocks) {
		if (block.type === 'heading') {
			const t = text(block.runs);
			if (out.length > 0 && out[out.length - 1] !== '') out.push('');
			if (block.level === 1) out.push(t.toUpperCase(), '='.repeat(Math.min(t.length, 72)));
			else if (block.level === 2) out.push(t, '-'.repeat(Math.min(t.length, 72)));
			else out.push(t);
			out.push('');
		} else if (block.type === 'paragraph') {
			out.push(text(block.runs), '');
		} else if (block.type === 'code') {
			out.push(...block.text.split('\n').map((l) => `    ${l}`), '');
		} else {
			for (const item of block.items) {
				out.push(
					`${'   '.repeat(item.level)}${item.ordered ? `${item.number}.` : item.level % 2 === 0 ? '•' : '-'} ${text(item.runs)}`
				);
			}
			out.push('');
		}
	}

	while (out.length > 0 && out[out.length - 1] === '') out.pop();
	return out.join(eol) + eol;
}

/** @type {Renderer} */
export async function render_txt(blocks, file) {
	await fs.promises.writeFile(file, blocks_to_text(blocks), 'utf-8');
}

export { plain_text };
