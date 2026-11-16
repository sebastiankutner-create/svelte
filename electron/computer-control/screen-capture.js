import process from 'node:process';

/**
 * Minimal shapes of the Electron APIs used here, so this module (and its tests) don't need
 * `electron` installed. Pass the real `desktopCapturer`, `screen` and `systemPreferences`.
 *
 * @typedef {{
 *   isEmpty(): boolean,
 *   getSize(): { width: number, height: number },
 *   resize(options: { width?: number, height?: number, quality?: 'good' | 'better' | 'best' }): NativeImageLike,
 *   toJPEG(quality: number): Buffer
 * }} NativeImageLike
 *
 * @typedef {{ id: string, name: string, display_id: string, thumbnail: NativeImageLike }} SourceLike
 *
 * @typedef {object} CaptureDeps
 * @property {{ getSources(options: { types: string[], thumbnailSize: { width: number, height: number }, fetchWindowIcons?: boolean }): Promise<SourceLike[]> }} desktopCapturer
 * @property {{ getAllDisplays(): Array<{ id: number, size: { width: number, height: number }, scaleFactor: number }>, getPrimaryDisplay(): { id: number } }} screen
 * @property {{ getMediaAccessStatus(type: 'screen'): string }} [systemPreferences]
 * @property {NodeJS.Platform} [platform]
 */

/**
 * @typedef {object} Screenshot
 * @property {string} label e.g. "monitor 1 (primary)"
 * @property {number} width
 * @property {number} height
 * @property {string} base64 JPEG, base64-encoded
 * @property {string} data_url `data:image/jpeg;base64,...`
 */

/** Groq accepts at most 5 images and ~4 MB of base64 image data per request. */
export const MAX_IMAGES = 5;
export const MAX_TOTAL_BASE64 = 3.5 * 1024 * 1024;

/** Longest side to downscale to; tried in order until everything fits. */
const SIZES = [1920, 1600, 1280, 1024, 768];
const JPEG_QUALITY = 75;

export class ScreenCaptureError extends Error {}

/**
 * Capture every monitor in the main process. Works while the assistant window is minimized
 * or hidden: `desktopCapturer` grabs the screens directly and needs no window.
 *
 * @param {CaptureDeps} deps
 * @returns {Promise<Screenshot[]>}
 */
export async function capture_all_screens(deps) {
	const platform = deps.platform ?? process.platform;

	if (platform === 'darwin' && deps.systemPreferences) {
		const status = deps.systemPreferences.getMediaAccessStatus('screen');
		if (status !== 'granted') {
			throw new ScreenCaptureError(
				'I need Screen Recording permission to see your screen. Turn it on in System Settings, Privacy and Security, Screen Recording, then restart me.'
			);
		}
	}

	const displays = deps.screen.getAllDisplays();
	const primary_id = deps.screen.getPrimaryDisplay().id;

	// ask for thumbnails at full native resolution of the largest display
	let width = 0;
	let height = 0;
	for (const d of displays) {
		width = Math.max(width, Math.round(d.size.width * d.scaleFactor));
		height = Math.max(height, Math.round(d.size.height * d.scaleFactor));
	}

	const sources = await deps.desktopCapturer.getSources({
		types: ['screen'],
		thumbnailSize: { width: width || 1920, height: height || 1080 },
		fetchWindowIcons: false
	});

	// keep the order of screen.getAllDisplays(), primary first
	const order = displays
		.map((d) => String(d.id))
		.sort((a, b) => Number(b === String(primary_id)) - Number(a === String(primary_id)));
	const rank = (/** @type {SourceLike} */ s) => {
		const i = order.indexOf(s.display_id);
		return i === -1 ? order.length : i;
	};

	const images = sources
		.filter((s) => !s.thumbnail.isEmpty())
		.sort((a, b) => rank(a) - rank(b))
		.slice(0, MAX_IMAGES)
		.map((s, i) => ({
			label:
				sources.length === 1
					? 'your screen'
					: `monitor ${i + 1}${s.display_id === String(primary_id) ? ' (primary)' : ''}`,
			image: s.thumbnail
		}));

	if (images.length === 0) {
		throw new ScreenCaptureError(
			platform === 'darwin'
				? "I tried to look, but the capture came back blank. That usually means Screen Recording permission isn't granted."
				: "I tried to look, but I couldn't capture any screen."
		);
	}

	for (const max_side of SIZES) {
		const shots = images.map(({ label, image }) => encode(label, image, max_side));
		const total = shots.reduce((n, s) => n + s.base64.length, 0);
		if (total <= MAX_TOTAL_BASE64 || max_side === SIZES[SIZES.length - 1]) return shots;
	}

	/* c8 ignore next */
	throw new ScreenCaptureError('unreachable');
}

/**
 * @param {string} label
 * @param {NativeImageLike} image
 * @param {number} max_side
 * @returns {Screenshot}
 */
function encode(label, image, max_side) {
	const size = image.getSize();
	let scaled = image;
	if (Math.max(size.width, size.height) > max_side) {
		scaled =
			size.width >= size.height
				? image.resize({ width: max_side, quality: 'good' })
				: image.resize({ height: max_side, quality: 'good' });
	}
	const { width, height } = scaled.getSize();
	const base64 = scaled.toJPEG(JPEG_QUALITY).toString('base64');
	return { label, width, height, base64, data_url: `data:image/jpeg;base64,${base64}` };
}
