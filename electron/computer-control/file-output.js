import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { first_h1, parse_markdown } from './markdown-blocks.js';
import { create_pdf_renderer, render_docx, render_txt } from './document-renderers.js';

/** @import { Renderer, PdfFonts } from './document-renderers.js' */

/** @typedef {'pdf' | 'docx' | 'txt'} FileFormat */

export const FORMATS = /** @type {const} */ ({
	pdf: { extension: '.pdf', spoken: 'PDF' },
	docx: { extension: '.docx', spoken: 'Word document' },
	txt: { extension: '.txt', spoken: 'text file' }
});

/**
 * "PDF", ".pdf", "word", "Word document", "doc", "text", "plain text", "notepad" → format.
 * @param {unknown} value
 * @returns {FileFormat | null}
 */
export function normalise_format(value) {
	if (typeof value !== 'string') return null;
	const v = value.toLowerCase().replace(/^\./, '').trim();
	if (/^(pdf|pdf file|pdf document|portable document)$/.test(v)) return 'pdf';
	if (/^(docx?|word|ms word|microsoft word|word (doc|document|file)|docx (file|document))$/.test(v))
		return 'docx';
	if (/^(txt|text|plain text|text file|txt file|plain text file|notepad|note)$/.test(v))
		return 'txt';
	return null;
}

/**
 * The user's Desktop. In Electron pass `app.getPath('desktop')`, which follows Windows
 * folder redirection (e.g. OneDrive); this fallback is only for outside Electron.
 */
export function default_desktop_dir() {
	return path.join(os.homedir(), 'Desktop');
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;

/**
 * Make a title safe as a file name on Windows, macOS and Linux.
 * @param {string | null | undefined} title
 */
export function safe_file_name(title) {
	let name = String(title ?? '')
		.normalize('NFC')
		.replace(/[\t\r\n]+/g, ' ')
		.replace(/[\p{Cc}\p{Cf}]/gu, '')
		.replace(/[<>:"/\\|?*]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		// Windows drops trailing dots and spaces, and leading dots make files hidden on Unix
		.replace(/^[.\s]+|[.\s]+$/g, '');

	if (name.length > 100)
		name = name
			.slice(0, 100)
			.replace(/[.\s]+$/, '')
			.trimEnd();
	if (WINDOWS_RESERVED.test(name)) name = `${name} document`;
	return name;
}

/**
 * Create an empty file at the first free name: "Title.pdf", "Title (1).pdf", "Title (2).pdf"...
 * The file is created with the `wx` flag, so an existing file is never overwritten, even if
 * another program creates one with the same name at the same moment.
 *
 * @param {string} dir
 * @param {string} base
 * @param {string} extension e.g. ".pdf"
 * @returns {{ file: string, file_name: string, renamed: boolean }}
 */
export function reserve_file(dir, base, extension) {
	for (let n = 0; n < 1000; n++) {
		const file_name = n === 0 ? `${base}${extension}` : `${base} (${n})${extension}`;
		const file = path.join(dir, file_name);
		try {
			fs.closeSync(fs.openSync(file, 'wx'));
			return { file, file_name, renamed: n > 0 };
		} catch (e) {
			if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'EEXIST') throw e;
		}
	}
	throw new Error(`Too many files named "${base}" already exist`);
}

export class FileSaveError extends Error {}

/**
 * @typedef {object} SavedFile
 * @property {string} file Full path.
 * @property {string} file_name e.g. "Black Holes (1).pdf"
 * @property {string} title The document title (first H1, or the topic).
 * @property {boolean} renamed Whether a number was added because the name was taken.
 * @property {string} wanted_name The name it would have had without the number.
 * @property {FileFormat} format
 */

/**
 * Parse the AI's Markdown, render it in the requested format and save it to the Desktop,
 * named after the first H1 heading (or the topic if there is none).
 *
 * @param {{
 *   markdown: string,
 *   format: FileFormat,
 *   topic?: string | null,
 *   dir?: string,
 *   pdf_fonts?: PdfFonts
 * }} input
 * @returns {Promise<SavedFile>}
 */
export async function save_document({
	markdown,
	format,
	topic,
	dir = default_desktop_dir(),
	pdf_fonts
}) {
	const spec = FORMATS[format];
	if (!spec)
		throw new FileSaveError(`I can't make "${format}" files. I can do PDF, Word or plain text.`);

	const blocks = parse_markdown(markdown);
	if (blocks.length === 0) throw new FileSaveError('There was nothing to put in the document.');

	const title = first_h1(blocks) || capitalise(topic) || 'Document';
	const base = safe_file_name(title) || safe_file_name(topic) || 'Document';

	if (!is_directory(dir)) throw new FileSaveError(`I couldn't find your Desktop folder (${dir}).`);

	/** @type {ReturnType<typeof reserve_file>} */
	let reserved;
	try {
		reserved = reserve_file(dir, base, spec.extension);
	} catch (e) {
		throw new FileSaveError(`I couldn't create a file on your Desktop: ${describe(e)}`);
	}

	/** @type {Renderer} */
	const render =
		format === 'pdf'
			? create_pdf_renderer({ fonts: pdf_fonts })
			: format === 'docx'
				? render_docx
				: render_txt;
	try {
		await render(blocks, reserved.file, { title });
	} catch (e) {
		// don't leave an empty or half-written file behind
		fs.rmSync(reserved.file, { force: true });
		throw new FileSaveError(`I couldn't write the ${spec.spoken}: ${describe(e)}`);
	}

	return {
		file: reserved.file,
		file_name: reserved.file_name,
		title,
		renamed: reserved.renamed,
		wanted_name: `${base}${spec.extension}`,
		format
	};
}

/** @param {string} dir */
function is_directory(dir) {
	try {
		return fs.statSync(dir).isDirectory();
	} catch {
		return false;
	}
}

/** @param {string | null | undefined} text */
function capitalise(text) {
	const t = (text ?? '').trim();
	return t ? t[0].toUpperCase() + t.slice(1) : '';
}

/** @param {unknown} e */
function describe(e) {
	const error = /** @type {NodeJS.ErrnoException} */ (e);
	if (error?.code === 'EACCES' || error?.code === 'EPERM') return 'permission denied';
	if (error?.code === 'ENOSPC') return 'the disk is full';
	return error?.message ?? String(e);
}

/**
 * What TARS says once the file is on disk.
 * @param {SavedFile} saved
 */
export function confirmation(saved) {
	if (saved.renamed) {
		return `Done. There was already a ${saved.wanted_name} on your Desktop, so I saved this one as ${saved.file_name}. It's on your Desktop.`;
	}
	return `Done. I saved ${saved.file_name} to your Desktop.`;
}
