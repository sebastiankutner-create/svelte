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
	},
	memory: {
		/**
		 * Call after every exchange; returns at once, fact extraction runs in the background.
		 * @param {string} user
		 * @param {string} assistant
		 */
		recordTurn(user, assistant) {
			return ipcRenderer.invoke('memory:record-turn', { user, assistant });
		},
		/**
		 * Chat messages with remembered facts and recent history already included.
		 * @param {{ system?: string, user: string, history_messages?: number }} input
		 */
		buildMessages(input) {
			return ipcRenderer.invoke('memory:build-messages', input);
		},
		context() {
			return ipcRenderer.invoke('memory:context');
		},
		facts() {
			return ipcRenderer.invoke('memory:facts');
		},
		/** @param {string} id */
		forget(id) {
			return ipcRenderer.invoke('memory:forget', id);
		}
	}
});
