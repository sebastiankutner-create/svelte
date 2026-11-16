/**
 * Recognises spoken requests to look at the screen, and splits off a follow-up question:
 *
 * - "analyze my screen" / "what do you see" / "look at my screen" → `{ question: null }` (describe it)
 * - "look at my screen and tell me which tab has the error" → `{ question: 'which tab has the error' }`
 * - anything else → `null`
 */

const SCREEN = String.raw`(?:screens?|displays?|monitors?|desktop|screenshot)`;
const OWNER = String.raw`(?:my|the|this|our)`;

const TRIGGERS = [
	new RegExp(
		String.raw`\b(?:analy[sz]e|look(?:ing)?\s+at|take\s+a\s+look\s+at|have\s+a\s+look\s+at|check(?:\s+out)?|scan|read|see|view|glance\s+at|inspect|examine|describe)\s+(?:what(?:'s|\s+is)\s+on\s+)?${OWNER}\s+${SCREEN}`,
		'i'
	),
	new RegExp(
		String.raw`\bwhat(?:'s|\s+is|\s+do\s+you\s+see|\s+can\s+you\s+see)\s+(?:on|in)\s+${OWNER}\s+${SCREEN}`,
		'i'
	),
	/\bwhat\s+(?:do|can)\s+you\s+see\b/i,
	/\b(?:take\s+a\s+)?screenshot\s+and\b/i
];

/** Leftovers that still just mean "describe it" */
const DESCRIBE_ONLY =
	/^(?:what(?:'s|\s+is)?\s+(?:you\s+(?:can\s+)?see|there|on\s+(?:it|there|the\s+screen|my\s+screen)|it\s+shows|is\s+(?:on\s+)?(?:it|there))|about\s+it|it|that|what\s+you\s+think|describe\s+it|what\s+(?:it|this)\s+is)$/i;

/**
 * @param {unknown} text
 * @returns {{ question: string | null } | null}
 */
export function parse_screen_request(text) {
	if (typeof text !== 'string') return null;
	const input = text.replace(/[’‘]/g, "'").trim();

	for (const trigger of TRIGGERS) {
		const match = trigger.exec(input);
		if (!match) continue;

		let rest = input.slice(match.index + match[0].length);
		rest = rest
			// "what do you see on my screen"
			.replace(new RegExp(String.raw`^\s*(?:on|in)\s+${OWNER}\s+${SCREEN}`, 'i'), '')
			// "..., and then can you please tell me"
			.replace(/^[\s,.;:!?-]*(?:(?:and|then|so|now)\b[\s,]*)*/i, '')
			.replace(/^(?:can|could|would|will)\s+you\s+/i, '')
			.replace(/^please\s+/i, '')
			.replace(/^(?:tell|let)\s+me(?:\s+know)?\s*/i, '')
			.replace(/^(?:explain|answer|say)\s+/i, '')
			.replace(/^[\s,:-]+/, '')
			.replace(/[\s.!?]+$/, '')
			.trim();

		if (rest.length < 2 || DESCRIBE_ONLY.test(rest)) return { question: null };
		return { question: rest };
	}

	return null;
}
