// Preload for the assistant window. CommonJS, because sandboxed preloads can't be ES modules.
// @ts-ignore -- `electron` is provided by the host app, not installed in this repo
// eslint-disable-next-line @typescript-eslint/no-require-imports -- sandboxed preloads must be CommonJS
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('assistant', {
	/** @param {(message: unknown) => void} callback */
	onVideo(callback) {
		ipcRenderer.on(
			'assistant:video',
			(/** @type {unknown} */ _event, /** @type {unknown} */ message) => callback(message)
		);
	},
	/** @param {unknown} command */
	run(command) {
		return ipcRenderer.invoke('computer-control:run', command);
	},
	/** @param {string} transcript */
	utterance(transcript) {
		return ipcRenderer.invoke('computer-control:utterance', transcript);
	}
});
