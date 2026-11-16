import { normalise_format } from './file-output.js';

/** @import { FileFormat } from './file-output.js' */

/**
 * Spoken file requests:
 *
 * - "make a PDF about the history of Rome" → `{ format: 'pdf', topic: 'the history of Rome' }`
 * - "write a Word document summarizing our Q3 goals" → `{ format: 'docx', topic: 'summarizing our Q3 goals' }`
 * - "create a text file with my packing list" → `{ format: 'txt', topic: 'my packing list' }`
 * - "put together a report on solar panels as a PDF" → `{ format: 'pdf', topic: 'a report on solar panels' }`
 */

const VERB = String.raw`(?:create|make|write|generate|draft|produce|prepare|build|put\s+together|save|export|type\s+up|give\s+me)`;
const FORMAT = String.raw`(pdf|word\s+doc(?:ument)?|word\s+file|docx|doc|text\s+file|txt(?:\s+file)?|plain\s+text\s+file|notepad\s+file)`;
// verbs that are part of what the document should do; kept in the topic
const KEEP = String.raw`summari[sz]ing|explaining|listing|comparing|covering|describing|outlining|detailing|analy[sz]ing`;
const LINK = String.raw`about|on|for|of|regarding|with|containing|that\s+(?:explains|lists|covers|summari[sz]es|describes)`;

const FORMAT_FIRST = new RegExp(
	String.raw`\b${VERB}\s+(?:me\s+)?(?:a|an|the|one)?\s*(?:new\s+|quick\s+|short\s+|simple\s+)?${FORMAT}(?:\s+(?:document|file|doc))?\s+(?:(${KEEP})\s+|(?:${LINK})\s+)?(.+)$`,
	'i'
);
const FORMAT_LAST = new RegExp(
	String.raw`\b${VERB}\s+(?:me\s+)?(.+?)\s+(?:as|in|into|to)\s+(?:a|an)?\s*${FORMAT}(?:\s+(?:document|file|format))?$`,
	'i'
);

/**
 * @param {unknown} text
 * @returns {{ format: FileFormat, topic: string } | null}
 */
export function parse_file_request(text) {
	if (typeof text !== 'string') return null;
	const input = text
		.replace(/[’‘]/g, "'")
		.trim()
		.replace(/[\s.!?]+$/, '');

	const first = FORMAT_FIRST.exec(input);
	if (first) {
		const format = format_of(first[1]);
		const topic = clean_topic(first[2] ? `${first[2]} ${first[3]}` : first[3]);
		if (format && topic) return { format, topic };
	}

	const last = FORMAT_LAST.exec(input);
	if (last) {
		const format = format_of(last[2]);
		const topic = clean_topic(
			last[1].replace(/^(?:a|an)\s+(?:document|doc|file)\s+(?:about|on|of)\s+/i, '')
		);
		if (format && topic) return { format, topic };
	}

	return null;
}

/** @param {string} raw */
function format_of(raw) {
	const v = raw.toLowerCase().replace(/\s+/g, ' ');
	if (v === 'doc') return 'docx';
	if (v === 'word doc') return 'docx';
	if (v === 'notepad file') return 'txt';
	return normalise_format(v.replace(/ file$/, '')) ?? normalise_format(v);
}

/** @param {string} topic */
function clean_topic(topic) {
	const trailing = [
		/\s+(?:and\s+)?(?:save|put|leave|drop|place)\s+it\s+(?:on|to)\s+(?:my|the)\s+desktop$/i,
		/\s+(?:on|to)\s+(?:my|the)\s+desktop$/i,
		/\s+(?:please|for\s+me|thanks|thank\s+you)$/i,
		/[\s,]+$/
	];
	let result = topic.trim();
	for (let changed = true; changed; ) {
		changed = false;
		for (const pattern of trailing) {
			const next = result.replace(pattern, '');
			if (next !== result) {
				result = next;
				changed = true;
			}
		}
	}
	return result.replace(/^["']|["']$/g, '').trim();
}
