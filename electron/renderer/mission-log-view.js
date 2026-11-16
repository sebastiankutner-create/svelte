/**
 * @typedef {{ id: number, at: string, level: 'error' | 'warn' | 'info', source: string, event: string, message: string, detail?: Record<string, unknown> }} LogEntry
 */

/**
 * Renders mission-log entries into a list, newest first. Entries are de-duplicated by id,
 * so replaying the history after live entries have arrived is safe. Text only: entries can
 * contain model output, so nothing is ever inserted as HTML.
 *
 * @param {HTMLOListElement} list
 * @param {{ max_entries?: number }} [options]
 */
export function create_mission_log_view(list, options = {}) {
	const max_entries = options.max_entries ?? 200;
	const doc = list.ownerDocument;
	/** @type {Set<number>} */
	const seen = new Set();

	/** @param {LogEntry} entry */
	function add(entry) {
		if (!entry || seen.has(entry.id)) return;
		seen.add(entry.id);

		const item = doc.createElement('li');
		item.className = `log-${entry.level}`;
		item.dataset.id = String(entry.id);

		const time = doc.createElement('time');
		time.dateTime = entry.at;
		time.textContent = new Date(entry.at).toLocaleTimeString();

		const source = doc.createElement('span');
		source.className = 'log-source';
		source.textContent = entry.source;

		const message = doc.createElement('span');
		message.className = 'log-message';
		message.textContent = entry.message;

		item.append(time, ' ', source, ' ', message);

		if (entry.detail && Object.keys(entry.detail).length > 0) {
			item.title = JSON.stringify(entry.detail, null, 2);
		}

		// keep newest first, even when older history arrives after a live entry
		const after = [...list.children].find(
			(child) => Number(/** @type {HTMLElement} */ (child).dataset.id) < entry.id
		);
		list.insertBefore(item, after ?? null);

		while (list.children.length > max_entries) list.lastElementChild?.remove();
	}

	return { add };
}
