const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { dateDirectory } = require('../src/activity.cjs');

// Electron calls that the test does not list do nothing.
const stub = calls => new Proxy(calls, { get: (target, key) => key in target ? target[key] : () => {} });

async function waitFor(condition) {
  const deadline = Date.now() + 3_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the overlay');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

// main.cjs keeps module state and reads CODEX_HOME once, so this file loads it in a single test.
test('shows recent activity during the first scan and despite an unreadable rollout', async t => {
  const now = Date.now();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'map-live-main-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const folder = dateDirectory(path.join(root, 'sessions'), new Date(now));
  const live = path.join(folder, 'rollout-live.jsonl');
  const turn = (at, type) => JSON.stringify({
    timestamp: new Date(at).toISOString(), type: 'event_msg', payload: { type, turn_id: 'live' },
  }) + '\n';
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(live, turn(now, 'task_started'));
  await fs.writeFile(path.join(folder, 'rollout-locked.jsonl'), '{}\n');
  const archive = dateDirectory(path.join(root, 'sessions'), new Date(now - 7 * 24 * 60 * 60_000));
  await fs.mkdir(archive, { recursive: true });
  await fs.writeFile(path.join(archive, 'rollout-archived.jsonl'), '{}\n');

  const open = fs.open;
  const release = Promise.withResolvers();
  t.after(() => release.resolve());
  t.mock.method(fs, 'open', async (file, ...args) => {
    if (path.basename(file) === 'rollout-locked.jsonl') throw Object.assign(new Error('denied'), { code: 'EACCES' });
    if (path.basename(file) === 'rollout-archived.jsonl') await release.promise;
    return open(file, ...args);
  });
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));

  const sent = [];
  const display = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1080 } };
  const window = stub({
    isDestroyed: () => false,
    loadFile: async () => {},
    getBounds: () => ({ x: 0, y: 0, width: 438, height: 628 }),
    webContents: stub({ send: (_channel, value) => sent.push(value) }),
  });
  const electron = {
    app: stub({
      commandLine: stub({ getSwitchValue: () => 'x11' }),
      requestSingleInstanceLock: () => true,
      whenReady: async () => {},
    }),
    BrowserWindow: function () { return window; },
    Tray: function () { return stub({}); },
    screen: stub({ getDisplayMatching: () => display, getDisplayNearestPoint: () => display, getAllDisplays: () => [display] }),
    globalShortcut: stub({}), ipcMain: stub({}), Menu: stub({}), nativeImage: stub({}),
  };
  const load = Module._load;
  t.mock.method(Module, '_load', (request, ...args) => request === 'electron' ? electron : load(request, ...args));
  // The overlay keeps polling after the test; that must not keep this test process alive.
  const setRepeating = setInterval;
  globalThis.setInterval = (...args) => setRepeating(...args).unref();
  process.env.CODEX_HOME = root;
  require('../src/main.cjs');

  // The archived rollout holds the first scan open until it is released.
  await waitFor(() => sent.at(-1)?.active);
  assert.equal(sent[0].outcome, 'Ready');
  release.resolve();
  await fs.appendFile(live, turn(Date.now(), 'task_complete'));
  await waitFor(() => sent.at(-1)?.outcome === 'Complete');
  assert.deepEqual(errors, ['Map Live: denied']);
});
