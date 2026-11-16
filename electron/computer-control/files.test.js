import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import zlib from 'node:zlib';
import {
	blocks_to_text,
	canonIntent,
	create_computer_control,
	create_mission_log,
	generate_markdown,
	parse_file_request,
	parse_inline,
	parse_markdown,
	register_computer_control,
	reserve_file,
	safe_file_name,
	save_document,
	to_win_ansi
} from './index.js';

const desktop = () => fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-'));

const SAMPLE = `Sure! Here's your document.

# Black Holes: A *Primer*

Black holes are regions where **gravity** wins. See [NASA](https://nasa.gov).

## Key facts

- Nothing escapes the event horizon
- They come in sizes:
  - stellar
  - supermassive
- Hawking radiation is \`tiny\`

## How one forms

1. A massive star runs out of fuel
2. The core collapses
3. A black hole is born

Further reading is optional.`;

/**
 * Minimal ZIP reader for checking .docx output.
 * @param {Buffer} zip
 * @param {string} name
 */
function read_zip_entry(zip, name) {
	const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
	const entries = zip.readUInt16LE(eocd + 10);
	let p = zip.readUInt32LE(eocd + 16);
	for (let i = 0; i < entries; i++) {
		const method = zip.readUInt16LE(p + 10);
		const size = zip.readUInt32LE(p + 20);
		const name_len = zip.readUInt16LE(p + 28);
		const extra_len = zip.readUInt16LE(p + 30);
		const comment_len = zip.readUInt16LE(p + 32);
		const local = zip.readUInt32LE(p + 42);
		const entry_name = zip.toString('utf-8', p + 46, p + 46 + name_len);
		if (entry_name === name) {
			const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
			const data = zip.subarray(start, start + size);
			return (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf-8');
		}
		p += 46 + name_len + extra_len + comment_len;
	}
	throw new Error(`${name} not in zip`);
}

test('Markdown is parsed into typed blocks', () => {
	const blocks = parse_markdown(SAMPLE);
	assert.deepEqual(
		blocks.map((b) => b.type),
		[
			'paragraph',
			'heading',
			'paragraph',
			'heading',
			'bullet_list',
			'heading',
			'numbered_list',
			'paragraph'
		]
	);

	const [, h1, para, , bullets, , numbered] = blocks;
	assert.deepEqual(h1, {
		type: 'heading',
		level: 1,
		runs: [{ text: 'Black Holes: A ' }, { text: 'Primer', italic: true }]
	});
	assert.deepEqual(para.type === 'paragraph' && para.runs, [
		{ text: 'Black holes are regions where ' },
		{ text: 'gravity', bold: true },
		{ text: ' wins. See ' },
		{ text: 'NASA', link: 'https://nasa.gov' },
		{ text: '.' }
	]);
	assert.deepEqual(
		bullets.type === 'bullet_list' &&
			bullets.items.map((i) => [i.level, i.runs.map((r) => r.text).join('')]),
		[
			[0, 'Nothing escapes the event horizon'],
			[0, 'They come in sizes:'],
			[1, 'stellar'],
			[1, 'supermassive'],
			[0, 'Hawking radiation is tiny']
		]
	);
	assert.deepEqual(
		numbered.type === 'numbered_list' && numbered.items.map((i) => i.number),
		[1, 2, 3]
	);
});

test('Markdown edge cases', () => {
	// wrapped in a code fence by the model
	assert.equal(parse_markdown('```markdown\n# Title\n\nBody\n```')[0].type, 'heading');
	// setext headings, starting numbers, nested numbering, bullets after numbers
	const blocks = parse_markdown(
		'Title\n=====\n\n3. three\n4. four\n   1. sub\n   2. sub\n5. five\n\n* star\n+ plus'
	);
	assert.deepEqual(blocks[0], { type: 'heading', level: 1, runs: [{ text: 'Title' }] });
	assert.deepEqual(
		blocks[1].type === 'numbered_list' && blocks[1].items.map((i) => `${i.level}:${i.number}`),
		['0:3', '0:4', '1:1', '1:2', '0:5']
	);
	assert.equal(blocks[2].type, 'bullet_list');

	assert.deepEqual(parse_inline('snake_case and 2*3*4 and \\*not italic\\*'), [
		{ text: 'snake_case and 2*3*4 and *not italic*' }
	]);
	assert.deepEqual(parse_inline('**unclosed bold'), [{ text: '**unclosed bold' }]);
	assert.deepEqual(parse_inline('***both***'), [{ text: 'both', bold: true, italic: true }]);
	// only web and mail links are kept as links
	assert.deepEqual(parse_inline('[click](javascript:alert(1))'), [{ text: 'click)' }]);
	assert.deepEqual(parse_markdown('').length, 0);
});

test('plain text rendering', () => {
	assert.equal(
		blocks_to_text(parse_markdown(SAMPLE), '\n'),
		`Sure! Here's your document.

BLACK HOLES: A PRIMER
=====================

Black holes are regions where gravity wins. See NASA (https://nasa.gov).

Key facts
---------

• Nothing escapes the event horizon
• They come in sizes:
   - stellar
   - supermassive
• Hawking radiation is tiny

How one forms
-------------

1. A massive star runs out of fuel
2. The core collapses
3. A black hole is born

Further reading is optional.
`
	);
});

test('file names are safe on every OS', () => {
	assert.equal(safe_file_name('Q3 Report: Sales / Marketing?'), 'Q3 Report Sales Marketing');
	assert.equal(safe_file_name('  ..hidden. '), 'hidden');
	assert.equal(safe_file_name('CON'), 'CON document');
	assert.equal(safe_file_name('a'.repeat(150)).length, 100);
	assert.equal(safe_file_name('Tab\there‮'), 'Tab here');
	assert.equal(safe_file_name('Café — Über'), 'Café — Über');
});

test('existing files are never overwritten: (1), (2), ... are appended', () => {
	const dir = desktop();
	fs.writeFileSync(path.join(dir, 'Notes.txt'), 'original');
	fs.writeFileSync(path.join(dir, 'Notes (1).txt'), 'also original');

	const reserved = reserve_file(dir, 'Notes', '.txt');
	assert.deepEqual(reserved, {
		file: path.join(dir, 'Notes (2).txt'),
		file_name: 'Notes (2).txt',
		renamed: true
	});
	assert.equal(fs.readFileSync(path.join(dir, 'Notes.txt'), 'utf-8'), 'original');
	assert.equal(fs.readFileSync(path.join(dir, 'Notes (1).txt'), 'utf-8'), 'also original');
});

test('PDF: A4, named after the first H1, complete when the promise resolves', async () => {
	const dir = desktop();
	const saved = await save_document({
		markdown: SAMPLE,
		format: 'pdf',
		topic: 'make a pdf about black holes',
		dir
	});

	assert.equal(saved.file_name, 'Black Holes A Primer.pdf');
	assert.equal(saved.title, 'Black Holes: A Primer');
	const pdf = fs.readFileSync(saved.file);
	// the stream has finished: the whole file, trailer included, is on disk
	assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
	assert.match(pdf.subarray(-16).toString(), /%%EOF\s*$/);
	assert.match(pdf.toString('latin1'), /\/MediaBox \[0 0 595\.28 841\.89\]/);
	assert.equal(fs.readdirSync(dir).length, 1);

	// a second one with the same title gets a number
	const again = await save_document({ markdown: SAMPLE, format: 'pdf', dir });
	assert.equal(again.file_name, 'Black Holes A Primer (1).pdf');
	assert.equal(again.renamed, true);
	assert.equal(again.wanted_name, 'Black Holes A Primer.pdf');
});

test('DOCX: headings, real Word lists, bold, links', async () => {
	const dir = desktop();
	const saved = await save_document({ markdown: SAMPLE, format: 'docx', dir });
	assert.equal(saved.file_name, 'Black Holes A Primer.docx');

	const xml = read_zip_entry(fs.readFileSync(saved.file), 'word/document.xml');
	assert.match(xml, /<w:pStyle w:val="Heading1"\/>[\s\S]*?Black Holes: A /);
	assert.match(xml, /<w:pStyle w:val="Heading2"\/>[\s\S]*?Key facts/);
	assert.match(xml, /<w:b\/>[\s\S]*?gravity/);
	assert.match(xml, /<w:hyperlink [^>]*r:id="[^"]+"[\s\S]*?NASA/);
	assert.equal(
		(xml.match(/<w:numPr>/g) ?? []).length,
		8,
		'every list item is a real Word list paragraph'
	);
	assert.match(
		read_zip_entry(fs.readFileSync(saved.file), 'word/_rels/document.xml.rels'),
		/https:\/\/nasa\.gov/
	);
	assert.match(
		read_zip_entry(fs.readFileSync(saved.file), 'docProps/core.xml'),
		/<dc:title>Black Holes: A Primer<\/dc:title>/
	);
});

test('TXT and the topic fallback when there is no H1', async () => {
	const dir = desktop();
	const saved = await save_document({
		markdown: '## Shopping\n\n- milk\n- eggs',
		format: 'txt',
		topic: 'my shopping list',
		dir
	});
	assert.equal(saved.file_name, 'My shopping list.txt');
	assert.equal(
		fs.readFileSync(saved.file, 'utf-8'),
		['Shopping', '--------', '', '• milk', '• eggs', ''].join(os.EOL)
	);

	const untitled = await save_document({ markdown: 'just text', format: 'txt', dir });
	assert.equal(untitled.file_name, 'Document.txt');
});

test('save errors are readable and leave nothing behind', async () => {
	await assert.rejects(
		save_document({ markdown: '# X', format: 'pdf', dir: path.join(desktop(), 'missing') }),
		/couldn't find your Desktop/
	);
	await assert.rejects(
		save_document({ markdown: '   ', format: 'pdf', dir: desktop() }),
		/nothing to put in the document/
	);

	// a renderer failure removes the reserved file
	const dir = desktop();
	await assert.rejects(
		save_document({
			markdown: '# Fonts',
			format: 'pdf',
			dir,
			pdf_fonts: {
				regular: '/nope.ttf',
				bold: '/nope.ttf',
				italic: '/nope.ttf',
				bold_italic: '/nope.ttf'
			}
		}),
		/couldn't write the PDF/
	);
	assert.deepEqual(fs.readdirSync(dir), []);
});

test('to_win_ansi keeps what Helvetica can draw and replaces the rest', () => {
	assert.equal(to_win_ansi('Café “quoted” – • € naïve'), 'Café “quoted” – • € naïve');
	assert.equal(to_win_ansi('a → b ≥ c ✓ Łódź 😀 日本'), 'a -> b >= c v Lódz  ');
});

test('parse_file_request', () => {
	/** @type {Record<string, unknown>} */
	const cases = {
		'make a PDF about the history of Rome': { format: 'pdf', topic: 'the history of Rome' },
		'Write a Word document summarizing our Q3 goals.': {
			format: 'docx',
			topic: 'summarizing our Q3 goals'
		},
		'create a text file with my packing list': { format: 'txt', topic: 'my packing list' },
		'put together a report on solar panels as a PDF': {
			format: 'pdf',
			topic: 'a report on solar panels'
		},
		'TARS, can you make me a short PDF on black holes and save it to my desktop please': {
			format: 'pdf',
			topic: 'black holes'
		},
		'write my cover letter for the Acme job as a word doc': {
			format: 'docx',
			topic: 'my cover letter for the Acme job'
		},
		'generate a docx explaining how vaccines work': {
			format: 'docx',
			topic: 'explaining how vaccines work'
		}
	};
	for (const [text, expected] of Object.entries(cases))
		assert.deepEqual(parse_file_request(text), expected, text);
	for (const text of [
		'create a google doc',
		'new document',
		'make a pdf',
		'open word',
		'play a video about pdfs'
	]) {
		assert.equal(parse_file_request(text), null, text);
	}
});

test('canonIntent maps file actions without stealing Google Doc links', () => {
	for (const v of [
		'create_file',
		'create file',
		'CreateFile',
		'make pdf',
		'save as docx',
		'export txt',
		'write word document',
		'generate file'
	]) {
		assert.equal(canonIntent(v), 'create_file', v);
	}
	assert.equal(canonIntent('create a google doc'), 'open_app');
	assert.equal(canonIntent('open word'), 'open_app');
});

/**
 * @param {{ markdown?: string | ((input: any) => Promise<string>), dir?: string }} [opts]
 */
function setup(opts = {}) {
	const dir = opts.dir ?? desktop();
	/** @type {string[]} */
	const spoken = [];
	/** @type {any[]} */
	const requests = [];
	const log = create_mission_log({ print: () => {} });
	const control = create_computer_control({
		user_data_dir: fs.mkdtempSync(path.join(os.tmpdir(), 'files-')),
		files: {
			dir,
			speak: (t) => spoken.push(t),
			log: log.log,
			generate:
				typeof opts.markdown === 'function'
					? opts.markdown
					: (input) => {
							requests.push(input);
							return Promise.resolve(/** @type {string | undefined} */ (opts.markdown) ?? SAMPLE);
						}
		}
	});
	return { dir, spoken, requests, control, log };
}

test('voice: "make a PDF about black holes" writes it to the Desktop and says so', async () => {
	const { dir, spoken, requests, control } = setup();

	const result = await control.handle_utterance('Make a PDF about black holes');
	assert.deepEqual(requests, [{ request: 'black holes', format_name: 'PDF' }]);
	assert.equal(result?.ok, true);
	assert.deepEqual(
		fs.readdirSync(dir),
		['Black Holes A Primer.pdf'],
		'named after the H1, not the voice command'
	);
	assert.deepEqual(spoken, [
		'Writing a PDF about black holes.',
		'Done. I saved Black Holes A Primer.pdf to your Desktop.'
	]);

	spoken.length = 0;
	await control.handle_utterance('make a pdf about black holes');
	assert.deepEqual(
		spoken.at(-1),
		"Done. There was already a Black Holes A Primer.pdf on your Desktop, so I saved this one as Black Holes A Primer (1).pdf. It's on your Desktop."
	);
	assert.equal(fs.readdirSync(dir).length, 2);
});

test('AI-routed: markdown passed in is used as-is; any action wording works', async () => {
	const { dir, requests, control } = setup();

	let result = await control.run({
		action: 'save as word',
		format: 'Word',
		markdown: '# Meeting Notes\n\n- one'
	});
	assert.equal(result.ok && result.file_name, 'Meeting Notes.docx');
	assert.equal(requests.length, 0, 'no generation when the AI already wrote the content');

	result = await control.run({ action: 'createFile', format: '.txt', topic: 'packing list' });
	assert.equal(result.ok && result.file_name, 'Black Holes A Primer.txt');
	assert.deepEqual(requests, [{ request: 'packing list', format_name: 'text file' }]);

	result = await control.run({ action: 'write a text file about tea' });
	assert.equal(result.ok, true);
	assert.equal(fs.readdirSync(dir).length, 3);

	result = await control.run({ action: 'create file', topic: 'tea' });
	assert.match(result.ok ? '' : result.error, /Which format/);
	result = await control.run({ action: 'create file', format: 'pdf' });
	assert.match(result.ok ? '' : result.error, /What should the document be about/);
});

test('failures are spoken and logged', async () => {
	const { spoken, log, control } = setup({ markdown: () => Promise.reject(new Error('boom')) });
	const result = await control.handle_utterance('make a pdf about tea');
	assert.equal(result?.ok, false);
	assert.equal(spoken.at(-1), 'Something went wrong making the file: boom');
	assert.deepEqual(
		log.entries().map((e) => [e.source, e.event, e.message]),
		[['files', 'create_failed', 'Something went wrong making the file: boom']]
	);

	const missing = setup({ dir: path.join(desktop(), 'nope') });
	await missing.control.handle_utterance('make a pdf about tea');
	assert.match(missing.spoken.at(-1) ?? '', /couldn't find your Desktop/);
});

test('register_computer_control saves to app.getPath("desktop") with memory facts in the prompt', async () => {
	const dir = desktop();
	/** @type {any[]} */
	const bodies = [];
	/** @type {any} */
	const fetch = (/** @type {string} */ _url, /** @type {any} */ init) => {
		bodies.push(JSON.parse(init.body));
		return Promise.resolve({
			ok: true,
			status: 200,
			json: () =>
				Promise.resolve({ choices: [{ message: { content: '# Tea Guide\n\nSteep it.' } }] })
		});
	};
	const real_fetch = globalThis.fetch;
	globalThis.fetch = fetch;
	const saved_key = process.env.GROQ_API_KEY;
	process.env.GROQ_API_KEY = 'k';
	try {
		/** @type {Map<string, Function>} */
		const handlers = new Map();
		register_computer_control({
			app: {
				getPath: (name) =>
					name === 'desktop' ? dir : fs.mkdtempSync(path.join(os.tmpdir(), 'ud-'))
			},
			ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
			memory: /** @type {any} */ ({
				context_block: () => 'What you remember:\n- The user prefers green tea.',
				record_turn() {}
			})
		});
		const result = await /** @type {Function} */ (handlers.get('computer-control:utterance'))(
			{},
			'make a text file about tea'
		);
		assert.equal(result.ok, true);
		assert.deepEqual(fs.readdirSync(dir), ['Tea Guide.txt']);
		assert.match(bodies[0].messages[0].content, /The user prefers green tea/);
		assert.equal(bodies[0].messages[1].content, 'Write a text file about: tea');
	} finally {
		globalThis.fetch = real_fetch;
		if (saved_key === undefined) delete process.env.GROQ_API_KEY;
		else process.env.GROQ_API_KEY = saved_key;
	}
});

test('generate_markdown error messages', async () => {
	/** @param {number} status @param {any} body */
	const reply = (status, body) =>
		/** @type {any} */ (
			() => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) })
		);
	await assert.rejects(
		generate_markdown(
			{ request: 'x', format_name: 'PDF' },
			{ api_key: 'k', fetch: reply(429, {}) }
		),
		/rate limited/
	);
	await assert.rejects(
		generate_markdown(
			{ request: 'x', format_name: 'PDF' },
			{ api_key: 'k', fetch: reply(200, { choices: [{ message: { content: '' } }] }) }
		),
		/empty document/
	);
	assert.equal(
		await generate_markdown(
			{ request: 'x', format_name: 'PDF' },
			{ api_key: 'k', fetch: reply(200, { choices: [{ message: { content: '# Hi' } }] }) }
		),
		'# Hi'
	);
});
