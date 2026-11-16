import { drawMap } from '../vendor/lot-map/hooks/draw';
import { setupFrom } from '../vendor/lot-map/hooks/setup';
import type { Board, Entry } from '../vendor/lot-map/types';

type View = 'tab' | 'compact' | 'fullscreen';

type Activity = {
  mode: 'live' | 'demo';
  active: boolean;
  startedAt: number;
  endedAt: number;
  outcome: string;
  view: View;
  board: Board;
};

declare global {
  interface Window {
    mapLive: {
      onActivity(callback: (activity: Activity) => void): void;
      selectView(view: View): void;
    };
  }
}

const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
const setup = setupFrom({
  coreName: 'CODEX',
  theme: 'dark',
  background: 'transparent',
  colors: [
    'background=#0b2235', 'node=#0c253c', 'line=#386f8f', 'spoke=#285473',
    'text=#e5f8ff', 'label=#9acbe4', 'faint=#8ab6ce', 'accent=#68d8ff',
    'active=#ffd28b', 'error=#ff879d', 'memory=#5ed7e8', 'memoryActive=#c3faff',
    'route=#74dcff',
  ],
});

function element(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error('Missing overlay element: ' + id);
  return node;
}

const hud = element('hud');
const edgeTab = element('edge-tab');
const minimize = element('minimize');
const resize = element('resize');
const map = element('map');
const signal = element('signal');
const status = element('status');
const count = element('count');
const feed = element('feed');
const source = element('source');
const elapsed = element('elapsed');
let current: Activity | undefined;

function span(className: string, value: string) {
  const node = document.createElement('span');
  node.className = className;
  node.textContent = value;
  return node;
}

function entryRow(entry: Entry) {
  const row = document.createElement('li');
  if (entry.status === 'run') row.className = 'running';
  if (entry.status === 'err' || entry.status === 'block') row.className = 'problem';
  const states = { run: 'Running', ok: 'Done', err: 'Failed', block: 'Ended' };
  const duration = entry.endedAt === undefined ? 0 : entry.endedAt - entry.startedAt;
  row.append(
    document.createElement('i'),
    span('station', setup.t.stations[entry.station]),
    span('label', entry.label),
    span('state', duration && entry.status === 'ok' ? (duration / 1000).toFixed(1) + ' s' : states[entry.status]),
  );
  return row;
}

function updateClock() {
  if (!current?.startedAt) {
    elapsed.textContent = '';
    return;
  }
  const seconds = Math.max(0, Math.floor(((current.endedAt || Date.now()) - current.startedAt) / 1000));
  const time = [Math.floor(seconds / 60), seconds % 60].map(part => String(part).padStart(2, '0'));
  elapsed.textContent = time.join(':');
}

function render(activity: Activity) {
  current = activity;
  const tab = activity.view === 'tab';
  const fullscreen = activity.view === 'fullscreen';
  edgeTab.hidden = !tab;
  edgeTab.dataset.active = String(activity.active);
  hud.hidden = tab;
  hud.classList.toggle('fullscreen', fullscreen);
  if (tab) return;

  resize.title = fullscreen ? 'Restore compact window' : 'Open fullscreen';
  resize.setAttribute('aria-label', resize.title);

  setup.motion = motion.matches ? 'reduced' : 'full';
  map.innerHTML = drawMap(activity.board, Date.now(), setup);
  status.textContent = activity.active ? 'Working' : activity.outcome;
  signal.dataset.active = String(activity.active);
  signal.dataset.outcome = activity.outcome;
  source.textContent = activity.mode === 'demo' ? 'Sample activity'
    : activity.startedAt ? 'Local Codex session' : 'Waiting for Codex activity';

  const latest = activity.board.entries.slice().reverse();
  const running = latest.filter(entry => entry.status === 'run');
  count.textContent = running.length ? running.length + ' running' : '';
  const rows = [...running, ...latest.filter(entry => entry.status !== 'run')].slice(0, fullscreen ? 10 : 4);
  feed.replaceChildren(...rows.map(entryRow));
  updateClock();
}

motion.addEventListener('change', () => { if (current && !hud.hidden) render(current); });
edgeTab.addEventListener('click', () => window.mapLive.selectView('compact'));
minimize.addEventListener('click', () => window.mapLive.selectView('tab'));
resize.addEventListener('click', () => window.mapLive.selectView(current?.view === 'fullscreen' ? 'compact' : 'fullscreen'));
window.mapLive.onActivity(render);
setInterval(updateClock, 300);
