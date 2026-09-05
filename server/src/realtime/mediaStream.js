// Twilio ⇄ OpenAI Realtime media-stream bridge (DESIGN.md §3, Stage 2).
// Registered as the WS route /media-stream. Protocol references (GA, verified
// against developers.openai.com/api/reference/resources/realtime):
//   client → server: session.update, input_audio_buffer.append,
//                    conversation.item.create, conversation.item.truncate,
//                    response.create
//   server → client: response.output_audio.delta (agent audio out),
//                    response.output_audio_transcript.done (agent transcript),
//                    conversation.item.input_audio_transcription.completed (caller),
//                    response.output_item.done (function calls), response.done,
//                    input_audio_buffer.speech_started (barge-in)
// Twilio side: connected/start/media/mark/stop in, media/clear/mark out.
// Audio is G.711 μ-law (audio/pcmu == g711_ulaw) end-to-end — no resampling.
import WebSocket from 'ws';
import config from '../config.js';
import { buildSessionConfig } from './agent.js';
import { executeTool, summarizeAction } from './tools.js';
import { summarizeCall } from './summary.js';
import * as calls from '../services/callService.js';
import { clearCallAuth } from '../services/employeeService.js';
import { broadcast } from '../lib/events.js';

const OPENAI_URL = () =>
  config.realtimeWsUrl ?? `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(config.realtimeModel)}`;

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** One Twilio media stream ⇄ one OpenAI Realtime session. Never throws. */
export function handleMediaStream(twilioWs, req) {
  const log = req.log.child({ route: 'media-stream' });

  let streamSid = null;
  let callSid = null;
  let call = null; // calls row
  let openAiWs = null;
  let openAiReady = false;
  let ended = false;

  // The GA Realtime API emits TWO events per function call: the item completion
  // (response.output_item.done, item.type=function_call) and the arguments
  // completion (response.function_call_arguments.done). Both carry the same
  // call_id, and a retry/relay can resend either. Execute each call_id once:
  // the first result is cached so a duplicate gets the same answer (same guard
  // as the web-call relay — a prod call double-booked every tool before this).
  const handledToolCalls = new Map();

  // Barge-in bookkeeping (canonical Twilio realtime pattern):
  // track which assistant item is playing and how much audio the caller heard.
  let latestMediaTimestamp = 0;
  let responseStartTimestamp = null;
  let lastAssistantItem = null;
  const markQueue = [];
  let framesOut = 0; // agent audio frames sent to Twilio (zombie-stream watchdog)

  const sendTwilio = (msg) => {
    if (twilioWs.readyState === WebSocket.OPEN) twilioWs.send(JSON.stringify(msg));
  };
  const sendOpenAi = (msg) => {
    if (openAiWs?.readyState === WebSocket.OPEN) openAiWs.send(JSON.stringify(msg));
  };

  function persistTranscript(speaker, text) {
    if (!call || !text || !String(text).trim()) return;
    const row = calls.addTranscript(call.id, speaker, String(text).trim());
    broadcast('call.transcript', { call_id: call.id, speaker, text: row.text, at: row.created_at });
  }

  async function finalizeOnce(status = 'completed') {
    if (ended || !call) return;
    ended = true;
    handledToolCalls.clear();
    clearCallAuth(call.id);
    const fresh = calls.getCall(call.id);
    if (!fresh?.ended_at) {
      const updated = calls.finalizeCall(call.id, { status });
      broadcast('call.ended', { call: updated });
    }
    // Post-call summary (skipped gracefully without an API key / in tests).
    summarizeCall(call.id).then((summarized) => {
      if (summarized) broadcast('call.ended', { call: summarized, summarized: true });
    });
  }

  async function handleFunctionCall(item) {
    const name = item.name;
    // Dedupe: the realtime API emits BOTH response.output_item.done (item
    // complete) and response.function_call_arguments.done (args complete) for
    // the SAME function call — execute it once, ignore the duplicate entirely.
    // (Live prod incident: every tool ran twice → two identical jobs booked.)
    const key = item.call_id ?? `noid_${name}_${JSON.stringify(safeParse(item.arguments ?? ''))}`;
    if (handledToolCalls.has(key)) {
      log.debug({ tool: name, call_id: item.call_id }, 'duplicate function-call event ignored');
      return;
    }
    const args = safeParse(item.arguments ?? '') ?? {};
    log.info({ tool: name, call_id: item.call_id }, 'tool call');
    const result = await executeTool(name, args, { callId: call?.id ?? null });
    handledToolCalls.set(key, result);
    if (call) {
      calls.addAgentAction(call.id, name, args, result);
      broadcast('call.action', {
        call_id: call.id,
        tool: name,
        args,
        summary: summarizeAction(name, args, result),
      });
    }
    sendOpenAi({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: item.call_id, output: JSON.stringify(result) },
    });
    sendOpenAi({ type: 'response.create' });
  }

  function handleBargeIn() {
    sendTwilio({ event: 'clear', streamSid });
    if (markQueue.length && responseStartTimestamp != null && lastAssistantItem) {
      const elapsed = latestMediaTimestamp - responseStartTimestamp;
      if (elapsed > 0) {
        sendOpenAi({
          type: 'conversation.item.truncate',
          item_id: lastAssistantItem,
          content_index: 0,
          audio_end_ms: elapsed,
        });
      }
    }
    markQueue.length = 0;
    responseStartTimestamp = null;
    lastAssistantItem = null;
  }

  // --- OpenAI side -------------------------------------------------------------

  function connectOpenAi() {
    if (!config.openaiApiKey && !config.realtimeWsUrl) {
      log.error('no OPENAI_API_KEY — cannot bridge audio; ending call');
      twilioWs.close();
      finalizeOnce('failed');
      return;
    }
    openAiWs = new WebSocket(OPENAI_URL(), {
      headers: config.openaiApiKey ? { Authorization: `Bearer ${config.openaiApiKey}` } : {},
    });

    openAiWs.on('open', () => {
      sendOpenAi({ type: 'session.update', session: buildSessionConfig({ audioFormat: 'audio/pcmu' }) });
      // Kick off the greeting so the agent speaks first.
      sendOpenAi({
        type: 'response.create',
        response: {
          instructions:
            'Greet the caller briefly: "Thanks for calling Gulf Breeze Air, this is Marina. How can I help you today?"',
        },
      });
      // Zombie-stream watchdog: if the greeting never produces audio frames to
      // Twilio within 15s, the media path is dead even though the session
      // acked (live incident: caller heard silence, socket stayed open 37s).
      // Surface it loudly so the operator can tell the caller to redial.
      setTimeout(() => {
        if (!ended && framesOut === 0) {
          log.warn('NO AGENT AUDIO within 15s of session start — media path may be dead; caller should redial');
          if (twilioWs.readyState === WebSocket.OPEN) {
            sendTwilio({ event: 'clear', streamSid });
          }
        }
      }, 15000);
    });

    openAiWs.on('message', async (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        log.warn('non-JSON message from OpenAI');
        return;
      }
      try {
        await handleOpenAiEvent(msg);
      } catch (err) {
        log.error({ err, type: msg?.type }, 'error handling OpenAI event'); // never crash the call
      }
    });

    openAiWs.on('close', () => {
      log.info('OpenAI socket closed');
      if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
      finalizeOnce();
    });
    openAiWs.on('error', (err) => {
      log.error({ err }, 'OpenAI socket error');
      if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
      finalizeOnce('failed');
    });
  }

  async function handleOpenAiEvent(msg) {
    switch (msg.type) {
      case 'session.updated':
        openAiReady = true;
        log.info('OpenAI session configured');
        break;

      // Agent audio out → Twilio. GA name first, beta name as fallback.
      case 'response.output_audio.delta':
      case 'response.audio.delta': {
        if (!streamSid) break;
        framesOut++;
        sendTwilio({ event: 'media', streamSid, media: { payload: msg.delta } });
        if (msg.item_id) lastAssistantItem = msg.item_id;
        if (responseStartTimestamp == null) responseStartTimestamp = latestMediaTimestamp;
        sendTwilio({ event: 'mark', streamSid, mark: { name: `resp_${msg.response_id ?? 'x'}` } });
        markQueue.push(msg.response_id ?? 'x');
        break;
      }

      // Agent transcript (GA first, beta fallback) → persist + broadcast.
      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done':
        persistTranscript('agent', msg.transcript);
        break;

      // Caller transcript → persist + broadcast.
      case 'conversation.item.input_audio_transcription.completed':
        persistTranscript('caller', msg.transcript);
        break;

      // Tool calls: GA output_item.done (item.type function_call) + beta fallback.
      case 'response.output_item.done':
        if (msg.item?.type === 'function_call') await handleFunctionCall(msg.item);
        break;
      case 'response.function_call_arguments.done':
        await handleFunctionCall({ name: msg.name, call_id: msg.call_id, arguments: msg.arguments });
        break;

      // Barge-in: caller started speaking over the agent.
      case 'input_audio_buffer.speech_started':
        handleBargeIn();
        break;

      case 'response.done':
        if (msg.response?.status === 'failed' || msg.response?.status === 'incomplete') {
          log.warn({ status: msg.response?.status, details: msg.response?.status_details }, 'response not completed');
        }
        break;

      case 'error':
        log.error({ error: msg.error }, 'OpenAI error event');
        break;

      default:
        // Session lifecycle, rate limits, deltas we don't need, etc.
        log.debug({ type: msg.type }, 'unhandled OpenAI event');
    }
  }

  // --- Twilio side ---------------------------------------------------------------

  twilioWs.on('message', async (data) => {
    const msg = safeParse(data.toString());
    if (!msg) return;
    try {
      switch (msg.event) {
        case 'connected':
          log.info('Twilio media stream connected');
          break;

        case 'start': {
          streamSid = msg.start?.streamSid ?? msg.streamSid;
          callSid = msg.start?.callSid ?? null;
          call = calls.createCall({
            call_sid: callSid,
            from_number: msg.start?.customParameters?.from ?? null,
            status: 'in-progress',
          });
          broadcast('call.started', { call });
          log.info({ streamSid, callSid, callId: call.id }, 'call started');
          connectOpenAi();
          break;
        }

        case 'media':
          latestMediaTimestamp = Number(msg.media?.timestamp ?? latestMediaTimestamp);
          if (openAiReady) {
            sendOpenAi({ type: 'input_audio_buffer.append', audio: msg.media.payload });
          }
          break;

        case 'mark':
          markQueue.shift();
          break;

        case 'stop':
          log.info({ callSid }, 'Twilio stream stopped');
          if (openAiWs && openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
          finalizeOnce();
          break;

        default:
          log.debug({ event: msg.event }, 'unhandled Twilio event');
      }
    } catch (err) {
      log.error({ err, event: msg?.event }, 'error handling Twilio event');
    }
  });

  twilioWs.on('close', () => {
    if (openAiWs && openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
    finalizeOnce();
  });
  twilioWs.on('error', (err) => {
    log.error({ err }, 'Twilio socket error');
    if (openAiWs && openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
    finalizeOnce('failed');
  });
}

export default async function mediaStreamRoute(app) {
  app.get('/media-stream', { websocket: true }, (socket, req) => {
    handleMediaStream(socket, req);
  });
}
