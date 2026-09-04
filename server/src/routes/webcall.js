// Web-call (browser WebRTC) event ingest (DESIGN.md §3 web-call fallback).
// The browser owns the Realtime data channel; tool calls and transcripts are
// relayed here so they execute against the SAME tool layer, persist to
// agent_actions/call_transcripts, and broadcast to the dashboard exactly like
// the Twilio media-stream bridge does (see realtime/mediaStream.js).
import { executeTool, summarizeAction } from '../realtime/tools.js';
import { summarizeCall } from '../realtime/summary.js';
import * as calls from '../services/callService.js';
import { clearCallAuth } from '../services/employeeService.js';
import { broadcast } from '../lib/events.js';

function safeParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// Dedupe guard: the Realtime API emits two events per function call, so a
// retry/double-relay must not execute twice. Keyed by `${callId}:${fcCallId}`,
// holds the first result so a duplicate gets the same answer. Entries are
// dropped when the call ends.
const handledToolCalls = new Map();

export default async function webcallRoutes(app) {
  // Tool execution + transcript relay for a live browser call.
  app.post('/api/webcall/:callId/event', async (req, reply) => {
    const call = calls.getCall(req.params.callId);
    if (!call) return reply.code(404).send({ error: 'call not found' });
    const body = req.body ?? {};

    if (body.type === 'tool_call') {
      const { name } = body;
      // arguments arrives as a JSON string from the Realtime event; accept an object too.
      const args = typeof body.arguments === 'string'
        ? safeParse(body.arguments) ?? {}
        : body.arguments ?? {};
      if (!name) return reply.code(400).send({ error: 'tool_call requires name' });

      const dedupeKey = body.call_id ? `${call.id}:${body.call_id}` : null;
      if (dedupeKey && handledToolCalls.has(dedupeKey)) {
        return { result: handledToolCalls.get(dedupeKey), deduplicated: true };
      }

      const result = await executeTool(name, args, { callId: call.id });
      calls.addAgentAction(call.id, name, args, result);
      broadcast('call.action', {
        call_id: call.id,
        tool: name,
        args,
        summary: summarizeAction(name, args, result),
      });
      if (dedupeKey) handledToolCalls.set(dedupeKey, result);
      return { result };
    }

    if (body.type === 'transcript') {
      const speaker = body.speaker === 'caller' ? 'caller' : 'agent';
      const text = String(body.text ?? '').trim();
      if (!text) return reply.code(400).send({ error: 'transcript requires text' });
      const row = calls.addTranscript(call.id, speaker, text);
      broadcast('call.transcript', { call_id: call.id, speaker, text: row.text, at: row.created_at });
      return { ok: true };
    }

    return reply.code(400).send({ error: "type must be 'tool_call' or 'transcript'" });
  });

  // Hang up: finalize the call row, broadcast call.ended, kick off the summary
  // flow — identical to the bridge's finalizeOnce().
  app.post('/api/webcall/:callId/end', async (req, reply) => {
    const call = calls.getCall(req.params.callId);
    if (!call) return reply.code(404).send({ error: 'call not found' });
    if (!call.ended_at) {
      const updated = calls.finalizeCall(call.id, { status: 'completed' });
      broadcast('call.ended', { call: updated });
      summarizeCall(call.id).then((summarized) => {
        if (summarized) broadcast('call.ended', { call: summarized, summarized: true });
      });
    }
    clearCallAuth(call.id);
    for (const key of handledToolCalls.keys()) {
      if (key.startsWith(`${call.id}:`)) handledToolCalls.delete(key);
    }
    return calls.getCall(call.id);
  });
}
