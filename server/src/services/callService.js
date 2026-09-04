// Platform persistence for calls / transcripts / agent actions / tasks
// (DESIGN.md §2 new tables). Shared by the media-stream bridge, the Twilio
// status callback, the handoff tool, and the /api/calls + /api/tasks routes.
import { randomUUID } from 'node:crypto';
import db from '../db/index.js';
import { broadcast } from '../lib/events.js';

const now = () => new Date().toISOString();

// --- calls -------------------------------------------------------------------

export function createCall({ call_sid = null, from_number = null, status = 'in-progress' } = {}) {
  const row = { id: `call_${randomUUID()}`, call_sid, from_number, started_at: now(), status };
  db.prepare(
    `INSERT INTO calls (id, call_sid, from_number, started_at, status) VALUES (?, ?, ?, ?, ?)`
  ).run(row.id, row.call_sid, row.from_number, row.started_at, row.status);
  return getCall(row.id);
}

export function getCall(id) {
  return db.prepare(`SELECT * FROM calls WHERE id = ?`).get(id) ?? null;
}

export function getCallBySid(callSid) {
  return db.prepare(`SELECT * FROM calls WHERE call_sid = ?`).get(callSid) ?? null;
}

/** Finalize a call once. Idempotent: if ended_at is already set, returns the row unchanged. */
export function finalizeCall(id, { status = 'completed', ended_at = now(), summary = undefined, outcome = undefined } = {}) {
  const call = getCall(id);
  if (!call) return null;
  if (call.ended_at && summary === undefined) return call; // already finalized
  db.prepare(
    `UPDATE calls SET
       ended_at = COALESCE(?, ended_at),
       status = ?,
       summary = COALESCE(?, summary),
       outcome = COALESCE(?, outcome)
     WHERE id = ?`
  ).run(ended_at, status, summary ?? null, outcome ?? null, id);
  return getCall(id);
}

export function setHandoffReason(id, reason) {
  db.prepare(`UPDATE calls SET handoff_reason = ? WHERE id = ?`).run(reason, id);
}

// --- transcripts + agent actions ----------------------------------------------

export function addTranscript(callId, speaker, text) {
  const row = { id: `trn_${randomUUID()}`, call_id: callId, speaker, text: String(text), created_at: now() };
  db.prepare(
    `INSERT INTO call_transcripts (id, call_id, speaker, text, created_at) VALUES (?, ?, ?, ?, ?)`
  ).run(row.id, row.call_id, row.speaker, row.text, row.created_at);
  return row;
}

export function addAgentAction(callId, tool, args, result) {
  const row = {
    id: `act_${randomUUID()}`,
    call_id: callId ?? null,
    tool,
    args: JSON.stringify(args ?? {}),
    result: JSON.stringify(result ?? null),
    created_at: now(),
  };
  db.prepare(
    `INSERT INTO agent_actions (id, call_id, tool, args, result, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(row.id, row.call_id, row.tool, row.args, row.result, row.created_at);
  return row;
}

// --- tasks ---------------------------------------------------------------------

/** Create a handoff/follow-up task and broadcast task.created. */
export function createTask({ kind, title, detail = null, call_id = null, job_id = null, customer_id = null }) {
  const row = { id: `tsk_${randomUUID()}`, kind, title, detail, call_id, job_id, customer_id, status: 'open', created_at: now() };
  db.prepare(
    `INSERT INTO tasks (id, kind, title, detail, call_id, job_id, customer_id, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(row.id, row.kind, row.title, row.detail, row.call_id, row.job_id, row.customer_id, row.status, row.created_at);
  broadcast('task.created', { task: row });
  return row;
}

// --- read models for the REST API ----------------------------------------------

export function listCalls(limit = 100) {
  return db
    .prepare(`SELECT * FROM calls ORDER BY started_at DESC LIMIT ?`)
    .all(Math.min(limit, 500));
}

export function getCallDetail(id) {
  const call = getCall(id);
  if (!call) return null;
  const transcripts = db
    .prepare(`SELECT id, speaker, text, created_at FROM call_transcripts WHERE call_id = ? ORDER BY created_at`)
    .all(id);
  const actions = db
    .prepare(`SELECT id, tool, args, result, created_at FROM agent_actions WHERE call_id = ? ORDER BY created_at`)
    .all(id)
    .map((a) => ({ ...a, args: JSON.parse(a.args || '{}'), result: JSON.parse(a.result || 'null') }));
  return { ...call, transcripts, agent_actions: actions };
}

export function listTasks(status = null) {
  if (status) {
    return db.prepare(`SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC`).all(status);
  }
  return db.prepare(`SELECT * FROM tasks ORDER BY created_at DESC`).all();
}

export function updateTaskStatus(id, status) {
  if (!['open', 'done'].includes(status)) {
    const err = new Error("status must be 'open' or 'done'");
    err.statusCode = 400;
    throw err;
  }
  const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id);
  if (!task) return null;
  db.prepare(`UPDATE tasks SET status = ? WHERE id = ?`).run(status, id);
  const updated = { ...task, status };
  broadcast('task.updated', { task: updated });
  return updated;
}
