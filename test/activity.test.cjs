const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ActivityReader, applyRecord, dateDirectory, newSession, snapshot } = require('../src/activity.cjs');

function record(at, type, payload) {
  return { timestamp: new Date(at).toISOString(), type, payload };
}

test('reads split JSONL records with a stale file timestamp and expires the finished turn', async () => {
  const now = Date.now();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'map-live-test-'));
  const folder = dateDirectory(root, new Date(now));
  const file = path.join(folder, 'rollout-test.jsonl');
  const stale = new Date(now - 2 * 60 * 60_000);
  const reader = new ActivityReader(root);
  const turn = (at, type) => JSON.stringify(record(at, 'event_msg', { type, turn_id: 'café' })) + '\n';
  try {
    await fs.mkdir(folder, { recursive: true });
    assert.equal(await reader.poll(now), undefined);

    const start = Buffer.from(turn(now, 'task_started'));
    const split = start.indexOf('é') + 1;
    await fs.writeFile(file, start.subarray(0, split));
    await fs.utimes(file, stale, stale);
    assert.equal(await reader.poll(now), undefined);
    await fs.appendFile(file, start.subarray(split));
    await fs.utimes(file, stale, stale);
    assert.equal((await reader.poll(now))?.turnId, 'café');

    await fs.appendFile(file, turn(now + 600, 'task_complete'));
    await fs.utimes(file, stale, stale);
    const complete = await reader.poll(now + 601);
    assert.equal(complete.active, false);
    assert.equal(complete.outcome, 'Complete');
    assert.equal(await reader.poll(now + 4601), undefined);
  } finally {
    await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await fs.rmdir(folder);
    await fs.rmdir(path.dirname(folder));
    await fs.rmdir(path.dirname(path.dirname(folder)));
    await fs.rmdir(root);
  }
});

test('matches desktop tool events and projects generic labels only', () => {
  const now = Date.now();
  const session = newSession(0);
  const append = (delta, type, payload) => applyRecord(session, record(now + delta, type, payload));
  append(0, 'event_msg', { type: 'task_started', turn_id: 'active' });
  append(15, 'turn_context', { model: 'gpt-6.1' });
  append(20, 'response_item', { type: 'custom_tool_call', name: 'exec', call_id: 'a', status: 'completed', input: 'await tools.apply_patch("private input")' });
  append(30, 'event_msg', { type: 'task_complete', turn_id: 'previous' });
  assert.equal(session.active, true);
  let call = snapshot(session).board.entries.at(-1);
  assert.equal(call.station, 'files');
  assert.equal(call.status, 'run');

  append(150, 'response_item', { type: 'custom_tool_call_output', call_id: 'a', output: 'private output' });
  call = snapshot(session).board.entries.at(-1);
  assert.deepEqual([call.endedAt - call.startedAt, call.status], [130, 'ok']);
  assert.doesNotMatch(JSON.stringify(snapshot(session)), /private/);
  append(180, 'event_msg', { type: 'turn_aborted', turn_id: 'active' });
  assert.equal(snapshot(session).outcome, 'Interrupted');
});

test('finds resumed activity in an older rollout even when its file timestamp stays old', async () => {
  const now = Date.now();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'map-live-resume-'));
  const old = new Date(now);
  old.setDate(old.getDate() - 7);
  const folder = dateDirectory(root, old);
  const file = path.join(folder, 'rollout-old-chat.jsonl');
  const line = (at, type, payload) => JSON.stringify(record(at, type, payload)) + '\n';
  const turn = (at, type, turnId) => line(at, 'event_msg', { type, turn_id: turnId });
  try {
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(file, turn(old.getTime(), 'task_started', 'past') +
      turn(old.getTime() + 500, 'task_complete', 'past'));
    await fs.utimes(file, old, old);
    const reader = new ActivityReader(root);
    assert.equal(await reader.poll(now), undefined);

    await fs.appendFile(file, turn(now + 500, 'task_started', 'resumed'));
    await fs.utimes(file, old, old);
    assert.equal((await reader.poll(now + 2_100))?.turnId, 'resumed');
    assert.equal((await new ActivityReader(root).poll(now + 2_100)).turnId, 'resumed');

    await fs.appendFile(file, line(now + 2_200, 'response_item', {
      type: 'function_call', name: 'exec_command', call_id: 'tool',
    }));
    assert.equal((await reader.poll(now + 2_300)).board.entries.at(-1).label, 'Shell command');
    await fs.appendFile(file, turn(now + 2_400, 'task_complete', 'resumed'));
    assert.equal((await reader.poll(now + 2_500)).outcome, 'Complete');
  } finally {
    await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await fs.rmdir(folder);
    await fs.rmdir(path.dirname(folder));
    await fs.rmdir(path.dirname(path.dirname(folder)));
    await fs.rmdir(root);
  }
});

test('bounds the number of open rollouts while finding the latest active turn', async t => {
  const now = Date.now();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'map-live-many-rollouts-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const folder = dateDirectory(root, new Date(now));
  await fs.mkdir(folder, { recursive: true });
  for (let i = 0; i < 24; i++) {
    const start = record(now + i, 'event_msg', { type: 'task_started', turn_id: String(i) });
    await fs.writeFile(path.join(folder, `rollout-${i}.jsonl`), JSON.stringify(start) + '\n');
  }

  const open = fs.open;
  let inFlight = 0;
  let peak = 0;
  t.mock.method(fs, 'open', async (...args) => {
    peak = Math.max(peak, ++inFlight);
    const handle = await open(...args);
    const close = handle.close;
    handle.close = async () => {
      await close.call(handle);
      inFlight--;
    };
    return handle;
  });

  assert.equal((await new ActivityReader(root).poll(now + 24)).turnId, '23');
  assert.equal(inFlight, 0);
  assert.ok(peak > 0 && peak <= 8, `opened ${peak} rollouts concurrently`);
});

test('reads every rollout before reporting a failed one', async t => {
  const now = Date.now();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'map-live-failed-rollout-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const folder = dateDirectory(root, new Date(now));
  await fs.mkdir(folder, { recursive: true });
  for (let i = 0; i < 12; i++) {
    const start = record(now + i, 'event_msg', { type: 'task_started', turn_id: String(i) });
    await fs.writeFile(path.join(folder, `rollout-${i}.jsonl`), JSON.stringify(start) + '\n');
  }

  const open = fs.open;
  const opened = new Set();
  let inFlight = 0;
  t.mock.method(fs, 'open', async (file, ...args) => {
    if (!opened.size) {
      opened.add(file);
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    }
    opened.add(file);
    inFlight++;
    const handle = await open(file, ...args);
    const close = handle.close;
    handle.close = async () => {
      await close.call(handle);
      inFlight--;
    };
    return handle;
  });

  const failure = await new ActivityReader(root).poll(now + 12).catch(error => error);
  assert.deepEqual(failure.errors.map(error => error.code), ['EACCES']);
  assert.equal(failure.message, 'denied');
  assert.equal(opened.size, 12);
  assert.equal(inFlight, 0);
  const failed = Number(path.basename([...opened][0]).match(/\d+/)[0]);
  assert.equal(failure.session.turnId, failed === 11 ? '10' : '11');
});

test('reports a repeated failure with the same message, whichever rollout fails first', async t => {
  const now = Date.now();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'map-live-failed-order-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const folder = dateDirectory(root, new Date(now));
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, 'rollout-a.jsonl'), '{}\n');
  await fs.writeFile(path.join(folder, 'rollout-b.jsonl'), '{}\n');

  let slow;
  t.mock.method(fs, 'open', async file => {
    if (path.basename(file) === slow) await new Promise(resolve => setTimeout(resolve, 20));
    throw Object.assign(new Error(`denied ${path.basename(file)}`), { code: 'EACCES' });
  });
  const reader = new ActivityReader(root);
  const messages = [];
  for (slow of ['rollout-a.jsonl', 'rollout-b.jsonl']) {
    const failure = await reader.poll(now).catch(error => error);
    assert.equal(failure.errors.length, 2);
    messages.push(failure.message);
  }
  assert.equal(messages[0], messages[1]);
});

test('reports recent activity while older rollouts are still being scanned', { timeout: 5_000 }, async t => {
  const now = Date.now();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'map-live-scan-progress-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const archive = dateDirectory(root, new Date(now - 7 * 24 * 60 * 60_000));
  const today = dateDirectory(root, new Date(now));
  await fs.mkdir(archive, { recursive: true });
  await fs.mkdir(today, { recursive: true });
  // Enough archived rollouts to occupy every read slot if they were scanned first.
  for (let i = 0; i < 8; i++) await fs.writeFile(path.join(archive, `rollout-history-${i}.jsonl`), '{}\n');
  const turn = record(now, 'event_msg', { type: 'task_started', turn_id: 'live' });
  await fs.writeFile(path.join(today, 'rollout-live.jsonl'), JSON.stringify(turn) + '\n');

  const readdir = fs.readdir;
  t.mock.method(fs, 'readdir', async (directory, options) => {
    const entries = await readdir(directory, options);
    const archived = entry => entry.name.startsWith('rollout-history-');
    return options.recursive ? entries.sort((a, b) => archived(b) - archived(a)) : entries;
  });
  const release = Promise.withResolvers();
  const open = fs.open;
  t.mock.method(fs, 'open', async (file, ...args) => {
    if (path.dirname(file) === archive) await release.promise;
    return open(file, ...args);
  });

  const reader = new ActivityReader(root);
  const progress = Promise.withResolvers();
  const poll = reader.poll(now, session => progress.resolve(session.turnId));
  try {
    assert.equal(await Promise.race([progress.promise, poll]), 'live');
  } finally {
    release.resolve();
    await poll;
  }

  let reported = false;
  assert.equal((await reader.poll(now + 2_100, () => { reported = true; }))?.turnId, 'live');
  assert.equal(reported, false);
});

test('skips a dormant Unix rollout at startup and recovers its turn when it grows', {
  skip: !['linux', 'darwin'].includes(process.platform),
}, async t => {
  const now = Date.now() + 2 * 60 * 60_000;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'map-live-dormant-rollout-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const old = new Date(now - 7 * 24 * 60 * 60_000);
  const folder = dateDirectory(root, old);
  const file = path.join(folder, 'rollout-dormant.jsonl');
  const turn = (at, type) => JSON.stringify(record(at, 'event_msg', { type, turn_id: 'past' })) + '\n';
  await fs.mkdir(folder, { recursive: true });
  const padding = size => JSON.stringify({ padding: 'x'.repeat(size) }) + '\n';
  await fs.writeFile(file, turn(old.getTime(), 'task_started') + padding(2 ** 20));
  await fs.utimes(file, old, old);

  const open = t.mock.method(fs, 'open');
  const reader = new ActivityReader(root);
  assert.equal(await reader.poll(now), undefined);
  assert.equal(open.mock.callCount(), 0);

  // The append alone pushes the turn start out of the last 2 MiB of the file.
  await fs.appendFile(file, padding(1.5 * 2 ** 20) + turn(now + 500, 'task_complete'));
  await fs.utimes(file, old, old);
  assert.equal((await reader.poll(now + 2_100))?.outcome, 'Complete');
});

test('recovers fresh activity at startup with Windows-style stale file times', async t => {
  const now = Date.now() + 2 * 60 * 60_000;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'map-live-stale-rollout-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const old = new Date(now - 7 * 24 * 60 * 60_000);
  const folder = dateDirectory(root, old);
  const file = path.join(folder, 'rollout-stale.jsonl');
  await fs.mkdir(folder, { recursive: true });
  const started = record(now, 'event_msg', { type: 'task_started', turn_id: 'active' });
  await fs.writeFile(file, JSON.stringify(started) + '\n');
  await fs.utimes(file, old, old);

  // Emulate stale stat timestamps even when this test runs outside Windows.
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  t.after(() => Object.defineProperty(process, 'platform', platform));
  assert.equal((await new ActivityReader(root).poll(now))?.turnId, 'active');
});

test('applies a tool output longer than the read buffer across polls', async t => {
  const now = Date.now();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'map-live-large-record-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const folder = dateDirectory(root, new Date(now));
  const file = path.join(folder, 'rollout-large.jsonl');
  const line = (at, type, payload) => JSON.stringify(record(at, type, payload)) + '\n';
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(file, line(now, 'event_msg', { type: 'task_started', turn_id: 'large' }) +
    line(now + 10, 'response_item', { type: 'function_call', name: 'exec_command', call_id: 'big' }));
  const reader = new ActivityReader(root);
  assert.equal((await reader.poll(now + 10)).board.entries.at(-1).status, 'run');

  const output = Buffer.from(line(now + 100, 'response_item', {
    type: 'function_call_output', call_id: 'big', output: 'x'.repeat(3 * 2 ** 20),
  }));
  await fs.appendFile(file, output.subarray(0, 2 ** 20));
  assert.equal((await reader.poll(now + 100)).board.entries.at(-1).status, 'run');
  await fs.appendFile(file, output.subarray(2 ** 20));
  const session = await reader.poll(now + 100);
  assert.equal(session.board.entries.at(-1).status, 'ok');
  assert.deepEqual(session.board.faults, {});
});

test('parses records that cross read chunk boundaries', async t => {
  const now = Date.now();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'map-live-chunks-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const folder = dateDirectory(root, new Date(now));
  await fs.mkdir(folder, { recursive: true });
  const line = (at, type, payload) => JSON.stringify(record(at, type, payload)) + '\n';
  let text = line(now, 'event_msg', { type: 'task_started', turn_id: 'chunks' });
  for (let i = 0; i < 3; i++) {
    text += line(now + i, 'response_item', {
      type: 'function_call', name: 'exec_command', call_id: `call-${i}`, arguments: 'x'.repeat(100_000),
    });
  }
  await fs.writeFile(path.join(folder, 'rollout-chunks.jsonl'), text);
  const session = await new ActivityReader(root).poll(now + 10);
  assert.deepEqual(session.board.entries.map(entry => entry.id), ['1', 'call-0', 'call-1', 'call-2']);
});

test('starts over when a rollout is rewritten shorter than what was read', async t => {
  const now = Date.now();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'map-live-rewritten-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const folder = dateDirectory(root, new Date(now));
  const file = path.join(folder, 'rollout-rewritten.jsonl');
  const turn = id => JSON.stringify(record(now, 'event_msg', { type: 'task_started', turn_id: id })) + '\n';
  await fs.mkdir(folder, { recursive: true });
  // The incomplete last record makes the read size larger than the resume offset.
  await fs.writeFile(file, turn('first') + '{"incomplete":"' + 'x'.repeat(100));
  const reader = new ActivityReader(root);
  assert.equal((await reader.poll(now)).turnId, 'first');

  await fs.writeFile(file, turn('second-rewrite'));
  assert.equal((await reader.poll(now)).turnId, 'second-rewrite');
});

test('reads only the last 2 MiB at startup and keeps a first record on the boundary', async t => {
  const now = Date.now();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'map-live-aligned-tail-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const folder = dateDirectory(root, new Date(now));
  const file = path.join(folder, 'rollout-aligned.jsonl');
  await fs.mkdir(folder, { recursive: true });
  const start = JSON.stringify(record(now, 'event_msg', { type: 'task_started', turn_id: 'aligned' })) + '\n';
  const padding = ' '.repeat(2 ** 21 - Buffer.byteLength(start) - 1) + '\n';
  await fs.writeFile(file, '{}\n' + start + padding);

  const open = fs.open;
  let bytesRead = 0;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args);
    const read = handle.read;
    handle.read = async (...readArgs) => {
      const result = await read.apply(handle, readArgs);
      bytesRead += result.bytesRead;
      return result;
    };
    return handle;
  });
  assert.equal((await new ActivityReader(root).poll(now))?.turnId, 'aligned');
  // The tail plus the byte before it, which shows whether the tail starts a record.
  assert.equal(bytesRead, 2 ** 21 + 1);
});
