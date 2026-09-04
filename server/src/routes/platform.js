// Platform read endpoints for the office UI (DESIGN.md §4): calls, tasks,
// and the web-call ephemeral token. WS /ws is wired in index.js.
import db from '../db/index.js';
import config from '../config.js';
import * as callSvc from '../services/callService.js';
import { buildSessionConfig } from '../realtime/agent.js';

const notFound = (reply, msg) => reply.code(404).send({ error: msg });

export default async function platformRoutes(app) {
  // --- calls -----------------------------------------------------------------
  app.get('/api/calls', async () => {
    const calls = db
      .prepare(`SELECT * FROM calls ORDER BY started_at DESC LIMIT 200`)
      .all();
    return { calls };
  });

  app.get('/api/calls/:id', async (req, reply) => {
    const call = db.prepare(`SELECT * FROM calls WHERE id = ?`).get(req.params.id);
    if (!call) return notFound(reply, 'call not found');
    const transcripts = db
      .prepare(`SELECT speaker, text, created_at FROM call_transcripts WHERE call_id = ? ORDER BY created_at`)
      .all(call.id);
    const agent_actions = db
      .prepare(`SELECT tool, args, result, created_at FROM agent_actions WHERE call_id = ? ORDER BY created_at`)
      .all(call.id)
      .map((a) => ({ ...a, args: JSON.parse(a.args || '{}'), result: JSON.parse(a.result || 'null') }));
    return { ...call, transcripts, agent_actions };
  });

  // --- tasks -----------------------------------------------------------------
  app.get('/api/tasks', async (req) => {
    const status = req.query.status ?? 'open';
    const where = status === 'all' ? '' : `WHERE status = ?`;
    const args = status === 'all' ? [] : [status];
    const tasks = db
      .prepare(`SELECT * FROM tasks ${where} ORDER BY created_at DESC LIMIT 200`)
      .all(...args);
    return { tasks };
  });

  app.patch('/api/tasks/:id', async (req, reply) => {
    const { status } = req.body ?? {};
    if (!['open', 'done'].includes(status)) {
      return reply.code(400).send({ error: "status must be 'open' or 'done'" });
    }
    // callService.updateTaskStatus also broadcasts task.updated on the bus.
    const task = callSvc.updateTaskStatus(req.params.id, status);
    return task ?? notFound(reply, 'task not found');
  });

  // --- web-call fallback (DESIGN.md §3) ---------------------------------------
  // Mints an ephemeral OpenAI Realtime client secret for browser WebRTC with
  // the SAME agent config (prompt + tools) as the phone bridge.
  // GA endpoint: POST https://api.openai.com/v1/realtime/client_secrets
  // 503 when no key is configured — the UI shows a friendly toast.
  app.post('/api/realtime-token', async (req, reply) => {
    if (!config.openaiApiKey) {
      return reply.code(503).send({ error: 'OPENAI_API_KEY is not set — web calling is disabled' });
    }
    const session = buildSessionConfig({ audioFormat: null }); // WebRTC default: pcm 24kHz
    session.model = config.realtimeModel;
    const res = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${config.openaiApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expires_after: { anchor: 'created_at', seconds: 600 },
        session,
      }),
    });
    if (!res.ok) {
      req.log.warn({ status: res.status }, 'realtime client_secrets failed');
      return reply.code(502).send({ error: `failed to mint realtime token (OpenAI HTTP ${res.status})` });
    }
    return res.json();
  });
}
