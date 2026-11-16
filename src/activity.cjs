const fs = require('node:fs/promises');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');

const HISTORY_BYTES = 2 * 1024 * 1024;
const CHUNK_BYTES = 128 * 1024;
const ACTIVE_WINDOW = 45 * 60_000;
const FADE_DELAY = 4_000;
const HISTORY_SCAN_INTERVAL = 2_000;

const toolKinds = [
  [/spawn_agent|send_message|followup_task|wait_agent|interrupt_agent|collab|subagent/i, 'agents', 'Agent activity'],
  [/apply_patch|read_file|write_file|file_search|view_image|list_dir/i, 'files', 'File operation'],
  [/browser|cua_repl|computer_use|playwright/i, 'browser', 'Browser activity'],
  [/web__|web_search|search_service|fetch_url|http_request/i, 'web', 'Web activity'],
  [/exec_command|write_stdin|shell|terminal/i, 'shell', 'Shell command'],
  [/^(?:exec|wait)$/i, 'shell', 'Tool execution'],
  [/memory/i, 'memory', 'Memory activity'],
  [/search_tool|tool_search|discover_tools|skills?/i, 'skills', 'Skill or tool lookup'],
  [/approval|permission|hook/i, 'hooks', 'Hook or approval'],
];

function board() {
  return { entries: [], counts: {}, faults: {} };
}

function add(session, station, label, at, options = {}) {
  const entry = {
    id: options.id ?? String(++session.sequence),
    station, label, startedAt: at, from: 'core', status: 'ok', ...options,
  };
  const entries = session.board.entries;
  entries.push(entry);
  if (entries.length > 80) {
    const oldestFinished = entries.findIndex(item => item.status !== 'run');
    if (oldestFinished >= 0) entries.splice(oldestFinished, 1);
  }
  const counts = session.board.counts;
  counts[station] = (counts[station] ?? 0) + 1;
  return entry;
}

function closeCall(session, entry, at, status) {
  entry.status = status;
  entry.endedAt = Math.max(at, entry.startedAt);
  if (status === 'err' || status === 'block') {
    const faults = session.board.faults;
    faults[entry.station] = (faults[entry.station] ?? 0) + 1;
  }
}

function applyRecord(session, record) {
  const p = record?.payload;
  const at = Date.parse(record?.timestamp);
  if (!p || !Number.isFinite(at)) return false;

  switch (p.type) {
    case 'task_started':
    case 'turn_started':
      if (record.type !== 'event_msg') return false;
      session.board = board();
      session.calls.clear();
      session.active = true;
      session.turnId = p.turn_id;
      session.startedAt = at;
      session.endedAt = 0;
      session.outcome = '';
      add(session, 'you', 'Turn started', at, { from: 'inbound' });
      break;
    case 'task_complete':
    case 'turn_completed':
    case 'turn_aborted':
    case 'task_failed': {
      if (record.type !== 'event_msg' || !session.active) return false;
      if (p.turn_id && session.turnId && p.turn_id !== session.turnId) return false;
      session.outcome = p.type === 'turn_aborted' ? 'Interrupted' : p.type === 'task_failed' ? 'Failed' : 'Complete';
      for (const entry of session.calls.values()) {
        closeCall(session, entry, at, session.outcome === 'Failed' ? 'err' : 'block');
      }
      session.calls.clear();
      session.active = false;
      session.endedAt = at;
      add(session, 'model', 'Turn ' + session.outcome.toLowerCase(), at, {
        ...(session.outcome === 'Complete' ? { mark: 'done' } : { status: session.outcome === 'Failed' ? 'err' : 'block' }),
      });
      break;
    }
    default:
      if (!session.active || !applyTurnRecord(session, record, at)) return false;
  }
  session.lastActivity = at;
  return true;
}

function applyTurnRecord(session, record, at) {
  const p = record.payload;
  if (record.type === 'turn_context') {
    if (typeof p.model !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(p.model)) return false;
    session.board.model = p.model.length > 16 ? p.model.slice(0, 15) + '…' : p.model;
    return true;
  }
  if (record.type === 'token_usage_record') {
    add(session, 'model', 'Model response', at);
    return true;
  }
  if (record.type === 'event_msg' && p.type === 'token_count') {
    const used = p.info?.total_token_usage?.total_tokens;
    const capacity = p.info?.model_context_window;
    if (!Number.isFinite(used) || !Number.isFinite(capacity) || capacity <= 0) return false;
    session.board.context = Math.max(0, Math.min(100, Math.round(100 * used / capacity)));
    return true;
  }
  if (record.type !== 'response_item') return false;
  const id = typeof p.call_id === 'string' ? p.call_id : p.id;
  if (!id) return false;
  const isCall = ['function_call', 'custom_tool_call', 'web_search_call'].includes(p.type);
  if (isCall && !session.calls.has(id)) {
    let tool = [p.namespace, p.name].filter(value => typeof value === 'string').join('/') || p.type;
    if (tool === 'exec' && typeof p.input === 'string') {
      const targets = [...new Set(Array.from(p.input.matchAll(/\btools\.([\w]+)\s*\(/g), match => match[1]))];
      if (targets.length === 1) tool = targets[0];
    }
    const [, station, label] = toolKinds.find(([pattern]) => pattern.test(tool)) ?? [null, 'hooks', 'Tool call'];
    // "completed" on a function call describes generation of its arguments.
    // The tool itself is running until its matching output is written.
    const status = p.status === 'failed' ? 'err' : p.type === 'web_search_call' && p.status === 'completed' ? 'ok' : 'run';
    const entry = add(session, station, label, at, { id, status });
    if (status === 'run') session.calls.set(id, entry);
    return true;
  }
  if (['function_call_output', 'custom_tool_call_output', 'web_search_call'].includes(p.type)) {
    const entry = session.calls.get(id);
    if (!entry) return false;
    const status = p.status === 'failed' || p.output?.is_error === true ? 'err' : 'ok';
    closeCall(session, entry, at, status);
    session.calls.delete(id);
    return true;
  }
  return false;
}

function newSession(offset) {
  return {
    offset, discardLine: offset > 0, decoder: new StringDecoder('utf8'), carry: '',
    sequence: 0, active: false, lastActivity: 0, startedAt: 0, endedAt: 0,
    board: board(), calls: new Map(),
  };
}

function readChunk(session, chunk) {
  const lines = (session.carry + session.decoder.write(chunk)).split('\n');
  session.carry = lines.pop();
  if (session.discardLine && lines.length) {
    lines.shift();
    session.discardLine = false;
  }
  for (const line of lines) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    applyRecord(session, record);
  }
}

async function readFile(file, size, session) {
  if (size <= session.offset) return;
  const handle = await fs.open(file, 'r');
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  try {
    while (session.offset < size) {
      const length = Math.min(CHUNK_BYTES, size - session.offset);
      const { bytesRead } = await handle.read(buffer, 0, length, session.offset);
      if (!bytesRead) break;
      session.offset += bytesRead;
      readChunk(session, buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
}

function dateDirectory(base, date) {
  const part = value => String(value).padStart(2, '0');
  return path.join(base, String(date.getFullYear()), part(date.getMonth() + 1), part(date.getDate()));
}

async function listRollouts(directory, recursive = false) {
  try {
    const files = await fs.readdir(directory, { withFileTypes: true, recursive });
    return files
      .filter(file => file.isFile() && /^rollout-.+\.jsonl$/.test(file.name))
      .map(file => path.join(file.parentPath ?? file.path, file.name));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function listRecentDirectories(base, now) {
  const today = new Date(now);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const results = await Promise.all([today, yesterday].map(date => listRollouts(dateDirectory(base, date))));
  return results.flat();
}

function visibleSession(sessions, now) {
  const candidates = [...sessions.values()];
  const active = candidates
    .filter(session => session.active && now - session.lastActivity < ACTIVE_WINDOW)
    .sort((a, b) => b.startedAt - a.startedAt);
  return active[0] ?? candidates
    .filter(session => session.endedAt && now - session.endedAt < FADE_DELAY)
    .sort((a, b) => b.endedAt - a.endedAt)[0];
}

class ActivityReader {
  constructor(base) {
    this.base = base;
    this.sessions = new Map();
    this.nextHistoryScan = -Infinity;
  }

  async poll(now = Date.now()) {
    // Resumed chats append to their original rollout, regardless of its folder date.
    const scanHistory = now >= this.nextHistoryScan;
    const files = new Set(await (scanHistory ? listRollouts(this.base, true) : listRecentDirectories(this.base, now)));
    if (scanHistory) this.nextHistoryScan = now + HISTORY_SCAN_INTERVAL;
    for (const [file, session] of this.sessions) {
      if (files.has(file)) continue;
      if (scanHistory) this.sessions.delete(file);
      else if (session.active && now - session.lastActivity < ACTIVE_WINDOW) files.add(file);
    }
    await Promise.all([...files].map(async file => {
      try {
        // Windows can leave mtime unchanged while Codex has the log open.
        // The byte offset tracks new records; event timestamps track activity.
        const stat = await fs.stat(file);
        let session = this.sessions.get(file);
        if (!session || stat.size < session.offset || stat.birthtimeMs !== session.birthtime) {
          session = newSession(Math.max(0, stat.size - HISTORY_BYTES));
          session.birthtime = stat.birthtimeMs;
          this.sessions.set(file, session);
        }
        await readFile(file, stat.size, session);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        this.sessions.delete(file);
      }
    }));
    return visibleSession(this.sessions, now);
  }
}

function snapshot(session, mode = 'live') {
  return {
    mode,
    active: session?.active ?? false,
    startedAt: session?.startedAt ?? 0,
    endedAt: session?.endedAt ?? 0,
    outcome: session?.outcome ?? '',
    board: session?.board ?? board(),
  };
}

module.exports = { ActivityReader, applyRecord, dateDirectory, newSession, snapshot };
