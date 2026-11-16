/**
 * @typedef {object} AppDefinition
 * @property {string} id Stable identifier, e.g. `"browser"`.
 * @property {string} name Human-readable name used in messages.
 * @property {string} path Absolute path to the executable (or `.app` bundle on macOS).
 * @property {string[]} [args] Extra arguments passed before any URL.
 * @property {string[]} intents Natural phrases that should open this app.
 * @property {boolean} [browser] Whether URLs can be passed to this app as an argument.
 * @property {boolean} [default_browser] Which browser to use for `open_url` when none is named.
 */

/** @type {Record<string, AppDefinition[]>} */
const DEFAULTS = {
	win32: [
		{
			id: 'browser',
			name: 'Microsoft Edge',
			path: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
			intents: [
				'browse the web',
				'web browser',
				'open the browser',
				'internet',
				'edge',
				'surf the web'
			],
			browser: true,
			default_browser: true
		},
		{
			id: 'chrome',
			name: 'Google Chrome',
			path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
			intents: ['chrome', 'google chrome'],
			browser: true
		},
		{
			id: 'notepad',
			name: 'Notepad',
			path: 'C:\\Windows\\System32\\notepad.exe',
			intents: ['notepad', 'text editor', 'take notes', 'write a note', 'edit text']
		},
		{
			id: 'calculator',
			name: 'Calculator',
			path: 'C:\\Windows\\System32\\calc.exe',
			intents: ['calculator', 'calc', 'do some math', 'calculate']
		},
		{
			id: 'files',
			name: 'File Explorer',
			path: 'C:\\Windows\\explorer.exe',
			intents: ['file explorer', 'explorer', 'my files', 'browse files', 'file manager']
		},
		{
			id: 'terminal',
			name: 'Command Prompt',
			path: 'C:\\Windows\\System32\\cmd.exe',
			intents: ['terminal', 'command prompt', 'cmd', 'command line', 'console']
		}
	],
	darwin: [
		{
			id: 'browser',
			name: 'Safari',
			path: '/Applications/Safari.app',
			intents: [
				'browse the web',
				'web browser',
				'open the browser',
				'internet',
				'safari',
				'surf the web'
			],
			browser: true,
			default_browser: true
		},
		{
			id: 'chrome',
			name: 'Google Chrome',
			path: '/Applications/Google Chrome.app',
			intents: ['chrome', 'google chrome'],
			browser: true
		},
		{
			id: 'notes',
			name: 'TextEdit',
			path: '/System/Applications/TextEdit.app',
			intents: ['textedit', 'text editor', 'take notes', 'write a note', 'edit text', 'notepad']
		},
		{
			id: 'calculator',
			name: 'Calculator',
			path: '/System/Applications/Calculator.app',
			intents: ['calculator', 'calc', 'do some math', 'calculate']
		},
		{
			id: 'files',
			name: 'Finder',
			path: '/System/Library/CoreServices/Finder.app',
			intents: ['finder', 'my files', 'browse files', 'file manager', 'file explorer']
		},
		{
			id: 'terminal',
			name: 'Terminal',
			path: '/System/Applications/Utilities/Terminal.app',
			intents: ['terminal', 'command line', 'console', 'shell']
		}
	],
	linux: [
		{
			id: 'browser',
			name: 'Firefox',
			path: '/usr/bin/firefox',
			intents: [
				'browse the web',
				'web browser',
				'open the browser',
				'internet',
				'firefox',
				'surf the web'
			],
			browser: true,
			default_browser: true
		},
		{
			id: 'chrome',
			name: 'Google Chrome',
			path: '/usr/bin/google-chrome',
			intents: ['chrome', 'google chrome'],
			browser: true
		},
		{
			id: 'notes',
			name: 'Text Editor',
			path: '/usr/bin/gedit',
			intents: ['text editor', 'take notes', 'write a note', 'edit text', 'notepad', 'gedit']
		},
		{
			id: 'calculator',
			name: 'Calculator',
			path: '/usr/bin/gnome-calculator',
			intents: ['calculator', 'calc', 'do some math', 'calculate']
		},
		{
			id: 'files',
			name: 'Files',
			path: '/usr/bin/nautilus',
			intents: ['my files', 'browse files', 'file manager', 'file explorer', 'nautilus']
		},
		{
			id: 'terminal',
			name: 'Terminal',
			path: '/usr/bin/gnome-terminal',
			intents: ['terminal', 'command line', 'console', 'shell']
		}
	]
};

/**
 * Default app definitions for a platform, used to seed `apps.json` on first run.
 * @param {NodeJS.Platform} platform
 * @returns {AppDefinition[]}
 */
export function default_apps(platform) {
	return structuredClone(DEFAULTS[platform] ?? DEFAULTS.linux);
}
