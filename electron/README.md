# Assistant: Electron main-process wiring

```js
// main.js
import path from 'node:path';
import { app, BrowserWindow, ipcMain, desktopCapturer, screen, systemPreferences } from 'electron';
import { register_computer_control, start_renderer_server } from './computer-control/index.js';

/** @type {BrowserWindow | null} */
let win = null;

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
    speak: (text) => {
      /* your TARS voice */
    }
  });
});
```

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
