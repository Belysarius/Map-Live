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
  const turn = (at, type) => JSON.stringify(record(at, 'event_msg', { type, turn_id: 'turn' })) + '\n';
  try {
    await fs.mkdir(folder, { recursive: true });
    assert.equal(await reader.poll(now), undefined);

    const start = turn(now, 'task_started');
    await fs.writeFile(file, start.slice(0, 45));
    await fs.utimes(file, stale, stale);
    assert.equal(await reader.poll(now), undefined);
    await fs.appendFile(file, start.slice(45));
    await fs.utimes(file, stale, stale);
    assert.equal((await reader.poll(now)).active, true);

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
    assert.equal((await reader.poll(now + 2_100)).turnId, 'resumed');
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
