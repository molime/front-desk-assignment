// Realtime server-event handler for the browser WebRTC call (DESIGN.md §3
// web-call fallback). Mirrors the event handling in the Twilio bridge
// (server/src/realtime/mediaStream.js), but tool execution is relayed to the
// backend (/api/webcall/:callId/event) so the SAME tool layer runs, actions
// persist, and the dashboard updates live.
//
// Kept DOM-free and dependency-injected so it can be unit-tested in node:
//   ctx = {
//     callId,                    // calls row id from /api/realtime-token
//     send(obj),                 // send JSON over the 'oai-events' data channel
//     postEvent?(body),          // POST /api/webcall/:callId/event (default: fetch)
//     handledCallIds?(Set),      // dedupe state; created lazily, one per session
//     onTranscript?({speaker, text}),
//     onToolStart?(name), onToolEnd?(name),
//   }

function defaultPostEvent(callId, body) {
  return fetch(`/api/webcall/${callId}/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());
}

/** Greeting kickoff, sent when the data channel opens (same instruction the
 * Twilio bridge uses — mediaStream.js sends this over the WS on connect). */
export function greetingMessage() {
  return {
    type: 'response.create',
    response: {
      instructions:
        'Greet the caller briefly: "Thanks for calling Gulf Breeze Air, this is Marina. How can I help you today?"',
    },
  };
}

async function handleFunctionCall(item, ctx) {
  const { callId, send } = ctx;
  // The Realtime API sends BOTH response.output_item.done AND
  // response.function_call_arguments.done for one function call — execute once.
  const fcId = item.call_id;
  if (fcId) {
    ctx.handledCallIds ??= new Set();
    if (ctx.handledCallIds.has(fcId)) return;
    ctx.handledCallIds.add(fcId);
  }
  const name = item.name;
  ctx.onToolStart?.(name);
  let result;
  try {
    const post = ctx.postEvent ?? ((body) => defaultPostEvent(callId, body));
    const res = await post({ type: 'tool_call', name, arguments: item.arguments ?? '{}', call_id: fcId ?? undefined });
    result = res?.result ?? res ?? { error: 'empty tool response' };
  } catch (err) {
    result = { error: err.message ?? String(err) };
  }
  ctx.onToolEnd?.(name);
  // Hand the result back to the Realtime session, then let the agent speak.
  send({
    type: 'conversation.item.create',
    item: { type: 'function_call_output', call_id: fcId, output: JSON.stringify(result) },
  });
  send({ type: 'response.create' });
}

function handleTranscript(speaker, text, ctx) {
  if (!text || !String(text).trim()) return;
  const clean = String(text).trim();
  ctx.onTranscript?.({ speaker, text: clean });
  const post = ctx.postEvent ?? ((body) => defaultPostEvent(ctx.callId, body));
  // fire-and-forget — persistence must not block the conversation
  post({ type: 'transcript', speaker, text: clean }).catch(() => {});
}

/**
 * Handle one Realtime server event from the data channel. GA event names
 * first, beta fallbacks second — same set as mediaStream.js.
 */
export async function handleRealtimeEvent(evt, ctx) {
  switch (evt?.type) {
    // Tool calls: GA output_item.done (item.type function_call) + beta fallback.
    case 'response.output_item.done':
      if (evt.item?.type === 'function_call') await handleFunctionCall(evt.item, ctx);
      break;
    case 'response.function_call_arguments.done':
      await handleFunctionCall({ name: evt.name, call_id: evt.call_id, arguments: evt.arguments }, ctx);
      break;

    // Caller transcript (input audio transcription).
    case 'conversation.item.input_audio_transcription.completed':
      handleTranscript('caller', evt.transcript, ctx);
      break;

    // Agent transcript (GA first, beta fallback).
    case 'response.output_audio_transcript.done':
    case 'response.audio_transcript.done':
      handleTranscript('agent', evt.transcript, ctx);
      break;

    default:
      break; // audio deltas, session lifecycle, rate limits — nothing to do
  }
}

/** Fire-and-forget call finalization (safe during page teardown). */
export function endWebCall(callId) {
  if (!callId) return;
  fetch(`/api/webcall/${callId}/end`, { method: 'POST', keepalive: true }).catch(() => {});
}
