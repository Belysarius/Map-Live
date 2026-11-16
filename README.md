# Map Live

Map Live is a desktop overlay that shows what Codex is doing while you work. A blue radar map groups activity into stations such as Files, Shell, Browser, and Agents. Gold waves show calls in progress, blue pulses show results coming back, and red signals flag failures or blocked calls. A feed below the map shows recent events and their durations when available.

## What it helps with

- **Keep an eye on a long task.** Leave the overlay beside your editor to see whether Codex has recorded a running tool call, is between calls, or has finished the turn.
- **Spot what needs a closer look.** If a station flashes red, open the Codex chat to inspect the associated error or blocked call.
- **See work happening in parallel.** The map shows which stations are busy. A count next to a station tells you how many calls are running there.

For example, ask Codex to run your project's tests, then switch back to your editor. While the test command runs, the Shell station has a gold wave. A blue pulse returns to the center when the tool returns. Open the Codex chat to read the test output and confirm whether the tests passed.

Keep the map in a compact window, expand it to fullscreen, or tuck it into an edge tab on supported desktops. In automatic mode, the compact overlay returns to the tab four seconds after a turn finishes.

## Run on Windows

Use Node.js 22.12 or newer, then run these from this folder:

```powershell
npm ci
npm run setup
```

Double-click **Launch Map Live.cmd**. Click the edge tab or the Windows tray icon to open the compact view. A Codex turn also opens it in automatic mode. Right-click the tray icon to switch views, resume automatic view changes, pause, preview, or quit. From a terminal, `npm start` runs live mode and `npm run demo` opens the preview.

The overlay starts in the upper-right. Drag the **Map Live** title to move the compact window, or drag the edge tab up and down along the right edge. Map Live remembers the two positions while it is running.

## Run on macOS or Linux

Use Node.js 22.12 or newer in a graphical desktop session. From the project folder:

```sh
npm ci
npm run setup
npm start
```

macOS and Linux support is experimental. Launch Map Live manually, then work in a local Codex session. Run `npm run demo` to use sample activity. Use the tray or menu bar icon, or right-click the overlay itself, for view, preview, pause, and quit controls.

- **macOS and Linux with X11 or XWayland:** The edge tab, compact window, and fullscreen are available. The launcher uses X11 when an X display is available.
- **Native Wayland:** Map Live opens in a normal resizable window. The compositor manages placement and minimization. Fullscreen uses the desktop's native fullscreen mode. Start it explicitly with `npm start -- --ozone-platform=wayland` to choose this mode.

Use **Ctrl+Tab** when Map Live has keyboard focus. You can also enable the global shortcut from the overlay menu. It uses **Control+Option+M** on macOS and **Ctrl+Alt+M** on Linux, where the desktop accepts the binding.

## Open with Codex on Windows

Run `powershell -NoProfile -File .\scripts\codex-startup.ps1` once to enable automatic opening for your Windows account. Windows starts the small companion at sign-in. It opens Map Live as soon as the Codex desktop window appears. Run the same command with `-Remove` to disable it.

Press **Ctrl+Tab** in Codex to cycle through the edge tab, compact window, and fullscreen. Click **−** to keep Map Live minimized in the tab until you reopen it. Click the tab to open the compact window, or use **Esc** in fullscreen to return to compact.

## Reading the map

| Visual | Meaning |
| --- | --- |
| Straight cyan connection | The station has no call running. A brighter line means it was used more during the turn. |
| Gold wave flowing outward | At least one call is running at the station. |
| Gold polygon and orbiting arcs | The outline grows as concurrent calls increase. Each arc represents one call, up to four. The badge shows the exact count. |
| Cyan pulse toward the center | A tool completed or a model response arrived. A hollow pulse from You starts a turn. |
| Dashed red connection and red badge | A failure or blocked call. |
| Blue glow around the center | A Codex turn is ongoing, even between tool calls. |
| Curved paths between stations | The order of recent recorded activity. |
| Ring expanding from the center | The turn completed. The inner percentage ring shows context-window usage. |

The feed puts running calls first and shows the most recent finished events below them. It shows elapsed time for completed calls with timestamps. When multiple local turns overlap, Map Live follows the active turn that started most recently.

### What lights up

| Station | Examples from local Codex events |
| --- | --- |
| You | A new turn starts. |
| Model | A model response is recorded. |
| Files | Recognized file tools, such as reading a file or applying a patch. |
| Shell | Terminal commands and tool batches. |
| Network and Browser | Recognized web searches, fetches, and browser actions. |
| Agents | Recognized agent calls, such as starting or waiting on a subagent. |
| Memory, Skills, and Hooks | Recognized memory, skill, tool lookup, and approval calls. Unclassified tool calls also appear under Hooks. |

## Activity source and privacy

Map Live reads local Codex session logs under `~/.codex/sessions`, or the `sessions` directory inside `CODEX_HOME` if set. When you resume a chat, it also checks logs from older dates. The map reflects the events Codex records in those files.

The overlay displays event categories and generic labels. Prompts, answers, command lines, and tool output stay out of the overlay. Map Live sends no activity data over the network and does not change Codex settings.

Run `npm test` to check the log reader.

## Credits

The SVG map renderer and its helpers are from [lot-map](https://github.com/alexeyw/lot-map/tree/a616402477a08ce8aea770d657f7fc4d957dbc00) by Aleksei Volodin. The upstream MIT license is in `vendor/lot-map/LICENSE`.
