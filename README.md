# Map Live

A Windows overlay for local Codex sessions. Active stations send animated gold waves across a cyan radial map. In automatic mode, the compact overlay returns to the edge tab four seconds after a turn finishes.

## Run on Windows

Use Node.js 22.12 or newer, then run these from this folder:

```powershell
npm ci
npm run setup
```

Double-click **Launch Map Live.cmd**. Click the edge tab or the Windows tray icon to open the compact view. A Codex turn also opens it in automatic mode. Right-click the tray icon to switch views, resume automatic view changes, pause, preview, or quit. From a terminal, `npm start` runs live mode and `npm run demo` opens the preview.

The overlay starts in the upper-right. Drag the **Map Live** title to move the compact window, or drag the edge tab up and down along the right edge. Map Live remembers the two positions while it is running. If multiple local turns overlap, it shows the most recently started active turn.

## Open with Codex

Run `powershell -NoProfile -File .\scripts\codex-startup.ps1` once to enable automatic opening for your Windows account. Windows starts the small companion at sign-in. It opens Map Live as soon as the Codex desktop window appears. Run the same command with `-Remove` to disable it.

Press **Ctrl+Tab** in Codex to cycle through the edge tab, compact window, and fullscreen. Click **−** to keep Map Live minimized in the tab until you reopen it. Click the tab to open the compact window, or use **Esc** in fullscreen to return to compact.

## Activity source

Map Live tails local Codex session rollouts under `%USERPROFILE%\.codex\sessions` (or `%CODEX_HOME%\sessions`). It checks older rollouts for activity when you resume a chat. The reader displays event categories and generic labels from those files. Prompts, answers, command lines, and tool output stay out of the window. Map Live sends no traffic and does not change Codex settings. Activity depends on the locally recorded events and their format.

Run `npm test` to check the reader.

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

## Credits

The SVG map renderer and its helpers are from [lot-map](https://github.com/alexeyw/lot-map/tree/a616402477a08ce8aea770d657f7fc4d957dbc00) by Aleksei Volodin. The upstream MIT license is in `vendor/lot-map/LICENSE`.
