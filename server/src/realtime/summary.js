// Post-call summary + outcome classification (DESIGN.md §3 lifecycle step 4).
// Uses chat completions against the persisted transcript. Skips gracefully
// when there is no API key, no transcript, or the call had no content.
import config from '../config.js';
import * as calls from '../services/callService.js';

const OUTCOMES = ['booked', 'rescheduled', 'cancelled', 'info', 'handoff', 'other'];

/**
 * Summarize one call. Returns the updated calls row (with summary + outcome),
 * or null when skipped/failed. Never throws.
 */
export async function summarizeCall(callId) {
  if (!config.openaiApiKey || config.realtimeWsUrl) return null; // no key, or fake-WS test mode
  const detail = calls.getCallDetail(callId);
  if (!detail || detail.transcripts.length === 0) return null;

  const transcript = detail.transcripts.map((t) => `${t.speaker === 'agent' ? 'Marina' : 'Caller'}: ${t.text}`).join('\n');
  const actions = detail.agent_actions
    .map((a) => `${a.tool}(${JSON.stringify(a.args)}) → ${a.result?.error ? `error: ${a.result.error}` : 'ok'}`)
    .join('\n');

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: AbortSignal.timeout(20000),
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.openaiApiKey}`,
      },
      body: JSON.stringify({
        model: config.summaryModel,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'You summarize front-desk phone calls for an HVAC company. Return strict JSON: ' +
              '{"summary": "2-3 sentences: who called, what they needed, what was done", ' +
              '"outcome": one of ' + OUTCOMES.join(' | ') + '}.',
          },
          {
            role: 'user',
            content: `Transcript:\n${transcript}\n\nActions taken:\n${actions || '(none)'}`,
          },
        ],
      }),
    });
    if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}`);
    const data = await res.json();
    const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? '{}');
    const outcome = OUTCOMES.includes(parsed.outcome) ? parsed.outcome : 'other';
    const summary = typeof parsed.summary === 'string' && parsed.summary.trim() ? parsed.summary.trim() : null;
    return calls.finalizeCall(callId, { status: detail.status ?? 'completed', summary, outcome });
  } catch (err) {
    console.error(`[summary] call ${callId} summarization failed:`, err.message);
    return null;
  }
}
