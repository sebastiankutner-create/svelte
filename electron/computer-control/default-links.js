/**
 * A deep link: a natural phrase that opens a specific web address in the browser.
 * `url` may contain `{placeholders}` that are filled from the `vars` object in `apps.json`
 * (e.g. `{instagram_handle}`). An empty placeholder is removed, so an unset handle
 * opens the site's home page instead of a broken profile URL.
 *
 * @typedef {object} LinkDefinition
 * @property {string} id
 * @property {string} name Human-readable name used in messages.
 * @property {string} url
 * @property {string[]} intents Natural phrases that should open this link.
 * @property {string} [browser] Open in this browser (an app id or name) instead of the default.
 */

/** @type {LinkDefinition[]} */
const LINKS = [
	{
		id: 'new_google_doc',
		name: 'a new Google Doc',
		url: 'https://docs.google.com/document/create',
		intents: [
			'new google doc',
			'new google document',
			'create a google doc',
			'new doc',
			'new document',
			'start a document'
		]
	},
	{
		id: 'new_google_sheet',
		name: 'a new Google Sheet',
		url: 'https://docs.google.com/spreadsheets/create',
		intents: ['new google sheet', 'new spreadsheet', 'create a spreadsheet', 'new sheet']
	},
	{
		id: 'new_google_slides',
		name: 'a new Google Slides deck',
		url: 'https://docs.google.com/presentation/create',
		intents: [
			'new google slides',
			'new presentation',
			'new slide deck',
			'new slides',
			'create a presentation'
		]
	},
	{
		id: 'new_google_form',
		name: 'a new Google Form',
		url: 'https://docs.google.com/forms/create',
		intents: ['new google form', 'new form', 'create a form', 'new survey']
	},
	{
		id: 'google_docs',
		name: 'Google Docs',
		url: 'https://docs.google.com/document/',
		intents: ['google docs', 'my docs', 'my documents']
	},
	{
		id: 'google_drive',
		name: 'Google Drive',
		url: 'https://drive.google.com/',
		intents: ['google drive', 'drive', 'my drive']
	},
	{
		id: 'new_email',
		name: 'a new Gmail message',
		url: 'https://mail.google.com/mail/?view=cm&fs=1',
		intents: [
			'new email',
			'compose email',
			'write an email',
			'send an email',
			'new gmail',
			'compose'
		]
	},
	{
		id: 'gmail',
		name: 'Gmail',
		url: 'https://mail.google.com/',
		intents: ['gmail', 'my email', 'check email', 'check my email', 'inbox', 'email']
	},
	{
		id: 'new_calendar_event',
		name: 'a new Google Calendar event',
		url: 'https://calendar.google.com/calendar/r/eventedit',
		intents: [
			'new event',
			'new calendar event',
			'create an event',
			'schedule a meeting',
			'new meeting'
		]
	},
	{
		id: 'google_calendar',
		name: 'Google Calendar',
		url: 'https://calendar.google.com/',
		intents: ['google calendar', 'calendar', 'my calendar', 'my schedule']
	},
	{
		id: 'instagram',
		name: 'Instagram',
		url: 'https://www.instagram.com/{instagram_handle}',
		intents: ['instagram', 'open instagram', 'my instagram', 'insta', 'ig']
	},
	{
		id: 'youtube',
		name: 'YouTube',
		url: 'https://www.youtube.com/',
		intents: ['youtube', 'watch videos', 'watch a video']
	},
	{
		id: 'new_x_post',
		name: 'a new post on X',
		url: 'https://x.com/compose/post',
		intents: [
			'new tweet',
			'write a tweet',
			'tweet',
			'new post on x',
			'post on x',
			'post on twitter'
		]
	},
	{
		id: 'x',
		name: 'X',
		url: 'https://x.com/home',
		intents: ['twitter', 'x', 'x com']
	},
	{
		id: 'linkedin',
		name: 'LinkedIn',
		url: 'https://www.linkedin.com/feed/',
		intents: ['linkedin']
	},
	{
		id: 'github',
		name: 'GitHub',
		url: 'https://github.com/',
		intents: ['github']
	},
	{
		id: 'new_github_repo',
		name: 'a new GitHub repository',
		url: 'https://github.com/new',
		intents: [
			'new repo',
			'new repository',
			'new github repo',
			'create a repo',
			'create a repository'
		]
	},
	{
		id: 'google_maps',
		name: 'Google Maps',
		url: 'https://www.google.com/maps',
		intents: ['google maps', 'maps', 'directions', 'a map']
	}
];

/** Values substituted into `{placeholders}` in link URLs. Fill these in `apps.json`. */
const VARS = {
	instagram_handle: ''
};

/** @returns {LinkDefinition[]} */
export function default_links() {
	return structuredClone(LINKS);
}

/** @returns {Record<string, string>} */
export function default_vars() {
	return { ...VARS };
}
