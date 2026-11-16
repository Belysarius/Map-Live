# Map Live

A Windows overlay for local Codex sessions. A cyan radial map and gold pulses show activity as it happens. In automatic mode, the compact overlay returns to the edge tab four seconds after a turn finishes.

## Run on Windows

Use Node.js 22.12 or newer, then run these from this folder:

```powershell
npm ci
npm run setup
```

Double-click **Launch Map Live.cmd**. Click the edge tab or start a Codex turn to see the feed. Right-click the tray icon to switch views, resume automatic view changes, pause, preview, or quit. Double-click the icon to toggle the animated preview. From a terminal, `npm start` runs live mode and `npm run demo` opens the preview.

The overlay appears in the upper-right of the monitor containing the cursor when it opens. If multiple local turns overlap, it shows the most recently started active turn.

## Open with Codex

Run `powershell -NoProfile -File .\scripts\codex-startup.ps1` once to enable automatic opening for your Windows account. Windows starts the small companion at sign-in. It opens Map Live as soon as the Codex desktop window appears. Run the same command with `-Remove` to disable it.

Press **Ctrl+Tab** in Codex to cycle through the edge tab, compact window, and fullscreen. Click **−** to keep Map Live minimized in the tab until you reopen it. Click the tab to open the compact window, or use **Esc** in fullscreen to return to compact.

## Activity source

Map Live tails today's and yesterday's local Codex session rollouts under `%USERPROFILE%\.codex\sessions` (or `%CODEX_HOME%\sessions`). The reader displays event categories and generic labels from those files. Prompts, answers, command lines, and tool output stay out of the window. Map Live sends no traffic and does not change Codex settings. Activity depends on the locally recorded events and their format.

Run `npm test` to check the reader.

## Credits

The SVG map renderer and its helpers are from [lot-map](https://github.com/alexeyw/lot-map/tree/a616402477a08ce8aea770d657f7fc4d957dbc00) by Aleksei Volodin. The upstream MIT license is in `vendor/lot-map/LICENSE`.
