# Assistant: Electron main-process wiring

```js
// main.js
import path from 'node:path';
import {
  app,
  BrowserWindow,
  ipcMain,
  desktopCapturer,
  screen,
  systemPreferences,
  powerMonitor
} from 'electron';
import {
  claim_single_instance,
  create_memory,
  create_mission_log,
  register_computer_control,
  save_memory_on_exit,
  start_renderer_server
} from './computer-control/index.js';

/** @type {BrowserWindow | null} */
let win = null;

// 1. Before anything else: a second launch focuses this window and exits, so two processes
//    never write the memory file at the same time.
if (claim_single_instance(app, () => win)) {
  // 2. The mission log: failures from background work, shown in the window and printed to stderr.
  const mission_log = create_mission_log({ get_window: () => win });
  // 3. Memory lives in ~/.tars/memory.json (or TARS_MEMORY_DIR), not in %APPDATA%.
  //    Fact-extraction, save and load failures are reported to the mission log.
  const memory = create_memory({ log: mission_log.log });
  // 4. Save synchronously on quit / window close / log-off / shutdown / Ctrl+C.
  save_memory_on_exit({ app, memory, powerMonitor });

  app.whenReady().then(async () => {
    // YouTube embeds fail on file:// (error 153), so serve the UI from http://127.0.0.1:<free port>
    const server = await start_renderer_server(path.join(import.meta.dirname, 'renderer'));
    app.on('will-quit', () => server.close());

    win = new BrowserWindow({
      width: 1100,
      height: 750,
      webPreferences: {
        preload: path.join(import.meta.dirname, 'preload.cjs'),
        contextIsolation: true,
        sandbox: true,
        // let "play a video about X" start with sound without a click
        autoplayPolicy: 'no-user-gesture-required',
        // keep voice recognition and playback running while minimized
        backgroundThrottling: false
      }
    });
    win.loadURL(server.url);

    register_computer_control({
      app,
      ipcMain,
      get_window: () => win,
      desktopCapturer,
      screen,
      systemPreferences,
      memory,
      mission_log,
      speak: (text) => {
        /* your TARS voice */
      }
    });
  });
}
```

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

| Say                                    | Does                                                            |
| -------------------------------------- | --------------------------------------------------------------- |
| "open google chrome", "browse the web" | launches the app from `userData/apps.json`                      |
| "new Google Doc", "open Instagram"     | opens the deep link from `apps.json` in the browser             |
| "analyze my screen", "what do you see" | captures all monitors and describes them by voice               |
| "look at my screen and tell me X"      | answers X using the screenshot                                  |
| "play a video about X"                 | scrapes YouTube search, loads the first result in the player    |
| "pause the video" / "resume the video" | sends `pauseVideo` / `playVideo`                                |
| "set volume to X"                      | sends `setVolume` (0–100; words like "forty" or "max" work too) |

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
