const { app, BrowserWindow, globalShortcut, ipcMain, Menu, Tray, nativeImage, screen } = require('electron');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ActivityReader, snapshot } = require('./activity.cjs');
const { preview } = require('./demo.cjs');

const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const isLinux = process.platform === 'linux';
const ozone = app.commandLine.getSwitchValue('ozone-platform');
const nativeWayland = isLinux && (ozone === 'wayland' ||
  (ozone !== 'x11' && (Boolean(process.env.WAYLAND_DISPLAY) || process.env.XDG_SESSION_TYPE === 'wayland')));
const shortcut = 'Control+Alt+M';
const width = 438;
const height = 628;
const tabWidth = 132;
const tabHeight = 42;
const sessionRoot = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'sessions');
const reader = new ActivityReader(sessionRoot);
const capturePath = process.argv.find(arg => arg.startsWith('--capture='))?.slice('--capture='.length);
const launchRequest = {
  cycle: process.argv.includes('--cycle-view'),
  fullscreen: process.argv.includes('--fullscreen'),
  notice: process.argv.includes('--show-on-launch'),
  demo: process.argv.includes('--demo'),
};
const pendingRequests = [];
const positions = {};
let selectedView = launchRequest.fullscreen ? 'fullscreen' : launchRequest.cycle ? 'compact' : undefined;
let shownView;
let demoStart = launchRequest.demo ? Date.now() - 9_900 : 0;
let window;
let tray;
let ready = false;
let liveValue;
let lastLive;
let lastTrayState;
let paused = false;
let polling = false;
let lastPayload;
let lastError;
let timer;
let captureStarted = false;
let tabDrag;
let movingCompact = false;

app.setName('Map Live');

function boundsFor(view, display, position) {
  if (view === 'fullscreen') return display.bounds;
  const { workArea } = display;
  const tab = view === 'tab';
  const inset = 16;
  const w = Math.min(tab ? tabWidth : width, workArea.width);
  const h = Math.min(tab ? tabHeight : height, workArea.height);
  const right = workArea.x + workArea.width - w;
  const bottom = workArea.y + workArea.height - h;
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  return {
    x: tab ? right : clamp(position?.x ?? right - inset, workArea.x, right),
    y: clamp(position?.y ?? workArea.y + (tab ? 26 : inset), workArea.y, bottom),
    width: w,
    height: h,
  };
}

function placeWindow() {
  if (nativeWayland) {
    const fullscreen = shownView === 'fullscreen';
    if (fullscreen !== window.isFullScreen()) window.setFullScreen(fullscreen);
    return;
  }
  const fallback = window.isVisible()
    ? screen.getDisplayMatching(window.getBounds())
    : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const position = positions[shownView];
  const display = screen.getAllDisplays().find(item => item.id === position?.displayId) ?? fallback;
  window.setBounds(boundsFor(shownView, display, position));
}

function handleTabDrag(action, dy) {
  if (action === 'end') {
    if (!tabDrag) return;
    tabDrag = undefined;
    presentActivity();
    return;
  }
  if (shownView !== 'tab') return;
  if (action === 'start') {
    const bounds = window.getBounds();
    tabDrag = { y: bounds.y, displayId: screen.getDisplayMatching(bounds).id };
    return;
  }
  if (action !== 'move' || !tabDrag || !Number.isFinite(dy)) return;
  const display = screen.getAllDisplays().find(item => item.id === tabDrag.displayId)
    ?? screen.getDisplayMatching(window.getBounds());
  const bounds = boundsFor('tab', display, { y: tabDrag.y + Math.round(dy) });
  positions.tab = { y: bounds.y, displayId: display.id };
  window.setBounds(bounds);
}

function selectView(view) {
  selectedView = nativeWayland && view === 'tab' ? 'compact' : view;
  presentActivity();
}

function cycleView() {
  if (nativeWayland) {
    selectView(shownView === 'fullscreen' ? 'compact' : 'fullscreen');
    return;
  }
  const view = shownView ?? 'tab';
  selectView(view === 'tab' ? 'compact' : view === 'compact' ? 'fullscreen' : 'tab');
}

function handleLaunch(request) {
  if (request.demo && !demoStart) togglePreview();
  if (request.fullscreen) selectView('fullscreen');
  if (request.cycle) cycleView();
  else if (request.notice) void refresh();
  else presentActivity();
}

function togglePreview() {
  demoStart = demoStart ? 0 : Date.now() - 9_900;
  if (demoStart && selectedView === 'tab') selectedView = 'compact';
  presentActivity();
}

function viewMenu() {
  return Menu.buildFromTemplate([
    { label: 'Map Live', enabled: false },
    { type: 'separator' },
    ...(!nativeWayland ? [{ label: 'Minimize to tab', click: () => selectView('tab'), enabled: shownView !== 'tab' }] : []),
    { label: 'Open compact window', click: () => selectView('compact'), enabled: shownView !== 'compact' },
    { label: 'Open fullscreen', click: () => selectView('fullscreen'), enabled: shownView !== 'fullscreen' },
    { label: 'Follow activity automatically', type: 'checkbox', checked: !selectedView, click: () => selectView() },
    { label: demoStart ? 'Stop preview' : 'Preview animation', click: togglePreview },
    {
      label: 'Pause live overlay', type: 'checkbox', checked: paused,
      click(item) { paused = item.checked; presentActivity(); },
    },
    ...(!isWindows ? [{
      label: `Global shortcut (${isMac ? 'Control+Option+M' : 'Ctrl+Alt+M'})`,
      type: 'checkbox',
      checked: globalShortcut.isRegistered(shortcut),
      click(item) {
        if (item.checked) {
          if (!globalShortcut.register(shortcut, cycleView)) {
            console.warn('Map Live: the global shortcut is unavailable.');
          }
        } else globalShortcut.unregister(shortcut);
        updateTray();
      },
    }] : []),
    { type: 'separator' },
    { label: 'Quit Map Live', click: () => app.quit() },
  ]);
}

function updateTray() {
  if (tray) tray.setContextMenu(viewMenu());
}

function publish(value) {
  const serialized = JSON.stringify(value);
  if (serialized === lastPayload) return;
  lastPayload = serialized;
  window.webContents.send('activity', value);
}

function presentActivity() {
  const session = demoStart ? preview(demoStart, Date.now()) : paused ? undefined : liveValue;
  const view = selectedView ?? (nativeWayland || (!tabDrag && session) ? 'compact' : 'tab');
  const value = session ?? (!paused && view === 'fullscreen' && lastLive?.endedAt ? lastLive
    : { ...snapshot(), outcome: paused ? 'Paused' : 'Ready' });
  if (shownView !== view) {
    tabDrag = undefined;
    movingCompact = false;
    shownView = view;
    const fullscreen = view === 'fullscreen';
    if (isWindows) {
      window.setFocusable(fullscreen);
      if (!fullscreen && window.isFocused()) window.blur();
    }
    placeWindow();
    if (!window.isVisible()) {
      if (fullscreen || nativeWayland) window.show();
      else window.showInactive();
    } else if (fullscreen && !nativeWayland) window.focus();
    if (!nativeWayland) window.setAlwaysOnTop(true, isWindows ? 'pop-up-menu' : 'floating');
  }
  const trayState = [shownView, selectedView, Boolean(demoStart), paused].join('/');
  if (trayState !== lastTrayState) {
    lastTrayState = trayState;
    updateTray();
  }
  publish({ ...value, view, canMinimizeToTab: !nativeWayland });
}

async function capture() {
  if (captureStarted || !capturePath) return;
  captureStarted = true;
  await new Promise(resolve => setTimeout(resolve, 680));
  if (!window.isVisible() || (!nativeWayland && !window.isAlwaysOnTop()) ||
      (isWindows && shownView !== 'fullscreen' && window.isFocused())) {
    throw new Error(`Unexpected window state: visible=${window.isVisible()}, topmost=${window.isAlwaysOnTop()}, focused=${window.isFocused()}`);
  }
  const selector = shownView === 'tab' ? '#edge-tab:not([hidden])' : '.hud:not([hidden]) #map svg';
  const rendered = await window.webContents.executeJavaScript(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
  if (!rendered) throw new Error('Overlay did not render the requested view.');
  if (shownView === 'fullscreen' && !nativeWayland) {
    const { width, height } = screen.getDisplayMatching(window.getBounds()).bounds;
    const actual = window.getBounds();
    if (actual.width !== width || actual.height !== height) throw new Error('Fullscreen overlay does not fill the display.');
  }
  const image = await window.webContents.capturePage();
  if (image.isEmpty()) throw new Error('Overlay capture was empty.');
  await fs.writeFile(path.resolve(capturePath), image.toPNG());
  app.quit();
}

function updateLive(session) {
  if (window.isDestroyed()) return;
  liveValue = session ? snapshot(session) : undefined;
  if (liveValue) lastLive = liveValue;
  presentActivity();
}

async function refresh() {
  if (polling || !window || window.isDestroyed()) return;
  polling = true;
  try {
    const now = Date.now();
    let failure;
    // A log that cannot be read still leaves the activity read from the others on screen.
    const live = demoStart || paused ? undefined : await reader.poll(now, updateLive).catch(error => {
      failure = error;
      return error.session;
    });
    if (window.isDestroyed()) return;
    updateLive(live);
    if (failure) throw failure;
    await capture();
    lastError = undefined;
  } catch (error) {
    if (lastError !== error.message) console.error('Map Live:', error.message);
    lastError = error.message;
    if (capturePath) app.exit(1);
  } finally {
    polling = false;
  }
}

async function initialize() {
  window = new BrowserWindow({
    width,
    height,
    show: false,
    frame: nativeWayland,
    transparent: !nativeWayland,
    backgroundColor: nativeWayland ? '#061522' : '#00000000',
    hasShadow: false,
    alwaysOnTop: !nativeWayland,
    skipTaskbar: isWindows,
    focusable: !isWindows || selectedView === 'fullscreen',
    resizable: nativeWayland,
    minimizable: nativeWayland,
    maximizable: nativeWayland,
    fullscreenable: nativeWayland,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  ipcMain.on('map-view', (event, view) => {
    if (event.sender !== window.webContents || !['tab', 'compact', 'fullscreen'].includes(view)) return;
    selectView(view);
  });
  ipcMain.on('map-tab-drag', (event, action, dy) => {
    if (event.sender === window.webContents) handleTabDrag(action, dy);
  });
  window.on('will-move', (event) => {
    if (shownView !== 'compact') {
      event.preventDefault();
      return;
    }
    movingCompact = true;
    selectedView = 'compact';
  });
  window.on('moved', () => {
    if (!movingCompact || shownView !== 'compact') return;
    movingCompact = false;
    const bounds = window.getBounds();
    const display = screen.getDisplayMatching(bounds);
    const position = boundsFor('compact', display, bounds);
    positions.compact = { x: position.x, y: position.y, displayId: display.id };
    if (position.x !== bounds.x || position.y !== bounds.y ||
        position.width !== bounds.width || position.height !== bounds.height) window.setBounds(position);
    presentActivity();
  });
  if (isLinux && !nativeWayland) {
    window.on('move', () => {
      if (shownView !== 'compact') return;
      const bounds = window.getBounds();
      const display = screen.getDisplayMatching(bounds);
      positions.compact = { x: bounds.x, y: bounds.y, displayId: display.id };
    });
  }
  if (nativeWayland) {
    window.on('leave-full-screen', () => {
      if (shownView === 'fullscreen') selectView('compact');
    });
  }
  if (!isWindows) {
    window.webContents.on('context-menu', () => viewMenu().popup({ window }));
  }
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.isAutoRepeat) return;
    const cycle = input.key === 'Tab' && input.control && !input.shift && !input.alt && !input.meta;
    const escape = input.key === 'Escape' && shownView === 'fullscreen';
    if (!cycle && !escape) return;
    event.preventDefault();
    if (cycle) cycleView();
    else selectView('compact');
  });
  await window.loadFile(path.join(__dirname, 'index.html'));
  try {
    const image = nativeImage.createFromPath(path.join(__dirname, 'tray.png'));
    tray = new Tray(isMac ? image.resize({ width: 18, height: 18 }) : image);
    tray.setToolTip('Map Live for Codex');
    tray.on('click', () => selectView('compact'));
  } catch (error) {
    if (isWindows) throw error;
    console.warn('Map Live: the tray icon is unavailable. Right-click the overlay for its menu.');
  }
  ready = true;
  for (const request of pendingRequests.splice(0)) handleLaunch(request);
  screen.on('display-metrics-changed', () => { if (window.isVisible() && !movingCompact) placeWindow(); });
  screen.on('display-removed', () => { if (window.isVisible()) placeWindow(); });
  presentActivity();
  await refresh();
  timer = setInterval(refresh, 425);
  if (capturePath) setTimeout(() => app.exit(2), 10_000).unref();
}

if (!capturePath && !app.requestSingleInstanceLock(launchRequest)) {
  app.quit();
} else {
  app.on('second-instance', (_event, _args, _directory, request) => {
    if (ready) {
      handleLaunch(request);
      if (nativeWayland && window.isMinimized()) window.restore();
    }
    else pendingRequests.push(request);
  });
  app.on('before-quit', () => clearInterval(timer));
  app.on('will-quit', () => { if (!isWindows) globalShortcut.unregisterAll(); });
  app.whenReady().then(initialize).catch(error => {
    console.error('Map Live:', error.message);
    app.exit(1);
  });
}
