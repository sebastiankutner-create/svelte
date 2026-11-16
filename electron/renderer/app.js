import { create_youtube_player } from './youtube-player.js';
import { create_mission_log_view } from './mission-log-view.js';

/**
 * @typedef {{ type: 'load', video_id: string, title?: string | null }
 *   | { type: 'command', func: string, args?: unknown[] }} VideoMessage
 */

const container = /** @type {HTMLElement} */ (document.querySelector('#video'));
const title = /** @type {HTMLElement} */ (document.querySelector('#video-title'));
const player = create_youtube_player(container);

/** @type {any} */ (window).assistant?.onVideo((/** @type {VideoMessage} */ message) => {
	if (message.type === 'load') {
		player.load(message.video_id);
		title.textContent = message.title ?? '';
		container.hidden = false;
	} else if (message.type === 'command') {
		player.command(message.func, message.args ?? []);
	}
});

const mission_log = create_mission_log_view(
	/** @type {HTMLOListElement} */ (document.querySelector('#mission-log'))
);
const bridge = /** @type {any} */ (window).assistant?.missionLog;
if (bridge) {
	bridge.onEntry(mission_log.add);
	bridge.history().then((/** @type {any[]} */ entries) => entries.forEach(mission_log.add));
}
