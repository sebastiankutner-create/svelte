# Assistant: Electron main-process wiring

`main.js` is the complete main process. If your app already has its own, the one change the
renderer needs is to stop loading from `file://`:

```js
import { shell } from 'electron';
import { load_renderer } from './computer-control/index.js';

// before: win.loadFile('renderer/index.html');
await load_renderer(win, path.join(import.meta.dirname, 'renderer'), {
  open_external: (url) => shell.openExternal(url)
});
```

`load_renderer()` serves the folder from `http://127.0.0.1:<free port>/` (bound to loopback
only) and loads the window from there. YouTube embeds reject `file://` pages with error 153.
It also keeps the window on that origin: navigation anywhere else, `file://` included, is
blocked, and web links open in the user's browser. The server stops when the window closes.
Pass `port` for a fixed port if you want `localStorage` to survive restarts.

Order in `main.js`: claim the single-instance lock, create the mission log and memory, hook
save-on-exit, then on `ready` create the window, call `register_computer_control()` and
`load_renderer()`.

## Memory

In the renderer, for every turn of the normal conversation:

```js
// build the request with remembered facts + recent history already in it
const messages = await window.assistant.memory.buildMessages({
  system: TARS_PROMPT,
  user: transcript
});
const reply = await callYourModel(messages);
speak(reply);
// returns at once; fact extraction runs in the background and never delays the voice
window.assistant.memory.recordTurn(transcript, reply);
```

If your model call happens in the main process instead, use `memory.build_messages()` and
`memory.record_turn()` directly. Screen analysis gets the facts automatically, and commands
handled by `utterance()` are added to the history (without fact extraction).

`memory.json` holds `{ conversation: [...], facts: [...] }`. Each save writes a temp file,
copies the current file to `memory.json.bak`, then renames the temp file into place. If the
main file is ever unreadable, the backup is loaded and the damaged file is kept as
`memory.json.corrupt-<time>`.

## Voice commands

In the renderer, send each voice transcript to `window.assistant.utterance(text)` first. It
handles screen requests and video commands (and speaks the reply); it returns `null` for
anything else, which then goes to your language model as usual. Commands the model produces
go to `window.assistant.run(command)`.

| Say                                                                                      | Does                                                                |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| "open google chrome", "browse the web"                                                   | launches the app from `userData/apps.json`                          |
| "new Google Doc", "open Instagram"                                                       | opens the deep link from `apps.json` in the browser                 |
| "analyze my screen", "what do you see"                                                   | captures all monitors and describes them by voice                   |
| "look at my screen and tell me X"                                                        | answers X using the screenshot                                      |
| "play a video about X"                                                                   | scrapes YouTube search, loads the first result in the player        |
| "pause the video" / "resume the video"                                                   | sends `pauseVideo` / `playVideo`                                    |
| "set volume to X"                                                                        | sends `setVolume` (0–100; words like "forty" or "max" work too)     |
| "make a PDF about X", "write a Word document summarizing X", "create a text file with X" | writes the document, saves it to the Desktop and says the file name |

Tests: `node --test electron/computer-control/*.test.js`

## Mission log

Background work that nobody is waiting on (fact extraction, memory saves) reports failures
to the mission log instead of failing silently. Each entry looks like:

```json
{
  "id": 7,
  "at": "2026-11-16T14:03:07.000Z",
  "level": "error",
  "source": "memory",
  "event": "extraction_failed",
  "message": "Fact extraction failed: Groq rate limit reached: Rate limit reached for model",
  "detail": {
    "kind": "http",
    "status": 429,
    "model": "openai/gpt-oss-20b",
    "duration_ms": 412,
    "request_id": "req_..."
  }
}
```

`detail.kind` is one of `network`, `timeout`, `http`, `bad_response`, `empty_output`,
`bad_output` or `unexpected`. A missing `GROQ_API_KEY` is logged once as a warning; memory
load recoveries and save failures are logged as `load_recovered` / `save_failed`.

In the renderer, `window.assistant.missionLog.onEntry(cb)` delivers live entries and
`missionLog.history()` returns the last 200 (including ones logged before the window
loaded). `renderer/mission-log-view.js` renders them; point it at your own list element.

## Files

Voice requests like "make a PDF about black holes" have Groq (`GROQ_DOCUMENT_MODEL`,
default `openai/gpt-oss-120b`, with remembered facts) write the document as Markdown. If your
own model already wrote it, send `{ action: 'create_file', format: 'pdf' | 'docx' | 'txt', markdown, topic }`
to `window.assistant.run()` and it is saved as-is.

The Markdown is parsed into headings, paragraphs, bullet and numbered lists (plus code
blocks) and rendered with pdfkit (A4, 2 cm margins), docx (`Packer.toBuffer()`) or plain
text. Files go to `app.getPath('desktop')`, named after the first `#` heading, or the topic if
there is none. An existing file is never overwritten: `Title (1).pdf`, `Title (2).pdf`, ...

PDFs use the built-in Helvetica, which covers Western European text; other characters are
transliterated or dropped. For full Unicode, pass TrueType fonts:
`create_computer_control({ files: { pdf_fonts: { regular, bold, italic, bold_italic } } })`.
Failures are spoken and logged to the mission log as `files/create_failed`.
