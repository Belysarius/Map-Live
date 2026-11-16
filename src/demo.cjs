const { applyRecord, newSession, snapshot } = require('./activity.cjs');

const duration = 24_000;
const events = [
  [0, 'event_msg', { type: 'task_started', turn_id: 'demo' }],
  [0, 'turn_context', { model: 'gpt-6.1' }],
  [0, 'event_msg', { type: 'token_count', info: { total_token_usage: { total_tokens: 61_000 }, model_context_window: 128_000 } }],
  [800, 'token_usage_record', {}],
  [1700, 'response_item', { type: 'function_call', name: 'read_file', call_id: 'files' }],
  [3500, 'response_item', { type: 'function_call_output', call_id: 'files' }],
  [4000, 'response_item', { type: 'function_call', name: 'spawn_agent', call_id: 'agents' }],
  [5700, 'response_item', { type: 'function_call', name: 'web_search', call_id: 'web' }],
  [8200, 'response_item', { type: 'function_call_output', call_id: 'web' }],
  [8700, 'response_item', { type: 'function_call', name: 'exec_command', call_id: 'shell' }],
  [9900, 'response_item', { type: 'function_call', name: 'browser', call_id: 'browser' }],
  [11100, 'response_item', { type: 'function_call_output', call_id: 'agents' }],
  [13000, 'response_item', { type: 'function_call_output', call_id: 'browser' }],
  [14400, 'response_item', { type: 'function_call', name: 'apply_patch', call_id: 'edit' }],
  [15200, 'response_item', { type: 'function_call_output', call_id: 'edit' }],
  [17200, 'response_item', { type: 'function_call_output', call_id: 'shell' }],
  [18400, 'token_usage_record', {}],
  [21000, 'event_msg', { type: 'task_complete', turn_id: 'demo' }],
];

function preview(start, now) {
  const elapsed = (now - start) % duration;
  const cycleStart = now - elapsed;
  const session = newSession(0);
  for (const [delay, type, payload] of events) {
    if (delay > elapsed) break;
    applyRecord(session, { type, payload, timestamp: new Date(cycleStart + delay).toISOString() });
  }
  session.board.agents = session.calls.has('agents') ? ['demo-agent'] : [];
  return snapshot(session, 'demo');
}

module.exports = { preview };
