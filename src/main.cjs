const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, screen } = require('electron');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ActivityReader, snapshot } = require('./activity.cjs');
const { preview } = require('./demo.cjs');

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
let selectedView = launchRequest.fullscreen ? 'fullscreen' : launchRequest.cycle ? 'compact' : undefined;
let shownView;
let demoStart = launchRequest.demo ? Date.now() - 9_900 : 0;
let window;
let tray;
let liveValue;
let lastLive;
let lastTrayState;
let paused = false;
let polling = false;
let lastPayload;
let lastError;
let timer;
let captureStarted = false;

app.setName('Map Live');

function placeWindow() {
  const display = window.isVisible()
    ? screen.getDisplayMatching(window.getBounds())
    : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  if (shownView === 'fullscreen') {
    window.setBounds(display.bounds);
    return;
  }
  const { workArea } = display;
  if (shownView === 'tab') {
    window.setBounds({
      x: workArea.x + workArea.width - tabWidth,
      y: workArea.y + 26,
      width: tabWidth,
      height: tabHeight,
    });
    return;
  }
  const inset = 16;
  const w = Math.min(width, workArea.width - 2 * inset);
  const h = Math.min(height, workArea.height - 2 * inset);
  window.setBounds({
    x: workArea.x + workArea.width - w - inset,
    y: workArea.y + inset,
    width: w,
    height: h,
  });
}

function selectView(view) {
  selectedView = view;
  presentActivity();
}

function cycleView() {
  const view = shownView ?? 'tab';
  selectView(view === 'tab' ? 'compact' : view === 'compact' ? 'fullscreen' : 'tab');
}

function handleLaunch(request) {
  if (request.notice) selectedView = undefined;
  if (request.demo && !demoStart) togglePreview();
  if (request.fullscreen) selectView('fullscreen');
  if (request.cycle) cycleView();
  else presentActivity();
}

function togglePreview() {
  demoStart = demoStart ? 0 : Date.now() - 9_900;
  if (demoStart && selectedView === 'tab') selectedView = 'compact';
  presentActivity();
}

function updateTray() {
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Map Live', enabled: false },
    { type: 'separator' },
    { label: 'Minimize to tab', click: () => selectView('tab'), enabled: shownView !== 'tab' },
    { label: 'Open compact window', click: () => selectView('compact'), enabled: shownView !== 'compact' },
    { label: 'Open fullscreen', click: () => selectView('fullscreen'), enabled: shownView !== 'fullscreen' },
    { label: 'Follow activity automatically', type: 'checkbox', checked: !selectedView, click: () => selectView() },
    { label: demoStart ? 'Stop preview' : 'Preview animation', click: togglePreview },
    {
      label: 'Pause live overlay', type: 'checkbox', checked: paused,
      click(item) { paused = item.checked; presentActivity(); },
    },
    { type: 'separator' },
    { label: 'Quit Map Live', click: () => app.quit() },
  ]));
}

function publish(value) {
  const serialized = JSON.stringify(value);
  if (serialized === lastPayload) return;
  lastPayload = serialized;
  window.webContents.send('activity', value);
}

function presentActivity() {
  const session = demoStart ? preview(demoStart, Date.now()) : paused ? undefined : liveValue;
  const view = selectedView ?? (session ? 'compact' : 'tab');
  const value = session ?? (!paused && view === 'fullscreen' && lastLive?.endedAt ? lastLive
    : { ...snapshot(), outcome: paused ? 'Paused' : 'Ready' });
  if (shownView !== view) {
    shownView = view;
    const fullscreen = view === 'fullscreen';
    window.setFocusable(fullscreen);
    if (!fullscreen && window.isFocused()) window.blur();
    placeWindow();
    if (!window.isVisible()) {
      if (fullscreen) window.show();
      else window.showInactive();
    } else if (fullscreen) window.focus();
    window.setAlwaysOnTop(true, 'pop-up-menu');
  }
  const trayState = [shownView, selectedView, Boolean(demoStart), paused].join('/');
  if (trayState !== lastTrayState) {
    lastTrayState = trayState;
    updateTray();
  }
  publish({ ...value, view });
}

async function capture() {
  if (captureStarted || !capturePath) return;
  captureStarted = true;
  await new Promise(resolve => setTimeout(resolve, 680));
  if (!window.isVisible() || !window.isAlwaysOnTop() || (shownView !== 'fullscreen' && window.isFocused())) {
    throw new Error(`Unexpected window state: visible=${window.isVisible()}, topmost=${window.isAlwaysOnTop()}, focused=${window.isFocused()}`);
  }
  const selector = shownView === 'tab' ? '#edge-tab:not([hidden])' : '.hud:not([hidden]) #map svg';
  const rendered = await window.webContents.executeJavaScript(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
  if (!rendered) throw new Error('Overlay did not render the requested view.');
  if (shownView === 'fullscreen') {
    const { width, height } = screen.getDisplayMatching(window.getBounds()).bounds;
    const actual = window.getBounds();
    if (actual.width !== width || actual.height !== height) throw new Error('Fullscreen overlay does not fill the display.');
  }
  const image = await window.webContents.capturePage();
  if (image.isEmpty()) throw new Error('Overlay capture was empty.');
  await fs.writeFile(path.resolve(capturePath), image.toPNG());
  app.quit();
}

async function refresh() {
  if (polling || !window || window.isDestroyed()) return;
  polling = true;
  try {
    const now = Date.now();
    const live = demoStart || paused ? undefined : await reader.poll(now);
    if (window.isDestroyed()) return;
    liveValue = live ? snapshot(live) : undefined;
    if (liveValue) lastLive = liveValue;
    presentActivity();
    await capture();
    lastError = undefined;
  } catch (error) {
    liveValue = undefined;
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
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: selectedView === 'fullscreen',
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
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
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'tray.png')));
  tray.setToolTip('Map Live for Codex');
  tray.on('double-click', togglePreview);
  for (const request of pendingRequests.splice(0)) handleLaunch(request);
  screen.on('display-metrics-changed', () => { if (window.isVisible()) placeWindow(); });
  await refresh();
  timer = setInterval(refresh, 425);
  if (capturePath) setTimeout(() => app.exit(2), 10_000).unref();
}

if (!capturePath && !app.requestSingleInstanceLock(launchRequest)) {
  app.quit();
} else {
  app.on('second-instance', (_event, _args, _directory, request) => {
    if (tray) handleLaunch(request);
    else pendingRequests.push(request);
  });
  app.on('before-quit', () => clearInterval(timer));
  app.whenReady().then(initialize).catch(error => {
    console.error('Map Live:', error.message);
    app.exit(1);
  });
}
