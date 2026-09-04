// Integration test: the /media-stream bridge against a FAKE OpenAI Realtime
// WebSocket server + a FAKE Twilio media-stream client. No real keys needed.
// Run: node scripts/test-bridge.js
import { WebSocketServer, WebSocket } from 'ws';

// --- env BEFORE importing app modules (config reads env at import time) --------
process.env.PORT = '18931';
process.env.OPENAI_REALTIME_WS_URL = 'ws://127.0.0.1:18930';
delete process.env.OPENAI_API_KEY; // bridge connects without auth to the fake

const { default: db } = await import('../src/db/index.js');
const { subscribe } = await import('../src/lib/events.js');

// Clean up rows from previous runs of this test (call_sid is reused every run).
const stale = db.prepare(`SELECT id FROM calls WHERE call_sid = 'CAtestcall123'`).all();
for (const s of stale) {
  db.prepare(`DELETE FROM call_transcripts WHERE call_id = ?`).run(s.id);
  db.prepare(`DELETE FROM agent_actions WHERE call_id = ?`).run(s.id);
}
db.prepare(`DELETE FROM calls WHERE call_sid = 'CAtestcall123'`).run();

let passed = 0, failed = 0;
const check = (label, cond, extra = '') => {
  if (cond) { passed++; console.log(`  PASS ${label}`); }
  else { failed++; console.log(`  FAIL ${label} ${extra}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- collect bus events ----------------------------------------------------------
const busEvents = [];
const unsub = subscribe('*', (e) => busEvents.push(e));

// --- fake OpenAI Realtime server -----------------------------------------------------
const oaiReceived = [];
let sessionUpdate = null;
let sawFunctionCallOutput = false;
let sawResponseCreateAfterTool = false;

const fakeOai = new WebSocketServer({ port: 18930 });
fakeOai.on('connection', (ws) => {
  let toolOutputSeen = false;
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    oaiReceived.push(msg.type);
    if (msg.type === 'session.update' && !sessionUpdate) {
      sessionUpdate = msg.session;
      ws.send(JSON.stringify({ type: 'session.updated', session: msg.session }));
      driveConversation(ws);
    }
    if (msg.type === 'conversation.item.create' && msg.item?.type === 'function_call_output') {
      sawFunctionCallOutput = true;
      toolOutputSeen = true;
      const output = JSON.parse(msg.item.output);
      check('tool output is find_customer result', Array.isArray(output.matches), msg.item.output.slice(0, 200));
    }
    if (msg.type === 'response.create' && toolOutputSeen) {
      sawResponseCreateAfterTool = true;
      ws.send(JSON.stringify({ type: 'response.done', response: { status: 'completed' } }));
      setTimeout(() => ws.close(), 100);
    }
  });
});

function driveConversation(ws) {
  const send = (m, delay) => setTimeout(() => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m)), delay);
  send({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', content_index: 0, transcript: 'Hi, my AC is out at 89 Harborlight.' }, 30);
  send({ type: 'response.output_audio.delta', response_id: 'r1', item_id: 'a1', output_index: 0, content_index: 0, delta: Buffer.from('fake-mulaw-audio').toString('base64') }, 60);
  send({ type: 'input_audio_buffer.speech_started', item_id: 'u2', audio_start_ms: 0 }, 90); // barge-in
  send({ type: 'response.output_audio_transcript.done', response_id: 'r1', item_id: 'a1', transcript: 'Let me look that up for you.' }, 120);
  send({
    type: 'response.output_item.done', response_id: 'r2', output_index: 0,
    item: { type: 'function_call', call_id: 'fc_1', name: 'find_customer', arguments: JSON.stringify({ query: '89 Harborlight' }) },
  }, 160);
}

// --- boot the real server -------------------------------------------------------------
await import('../src/index.js');
await sleep(800);

// --- fake Twilio client -----------------------------------------------------------------
const twilioReceived = [];
const tw = new WebSocket('ws://127.0.0.1:18931/media-stream');
await new Promise((res, rej) => { tw.on('open', res); tw.on('error', rej); });
tw.on('message', (d) => twilioReceived.push(JSON.parse(d.toString())));

const sendT = (m) => tw.send(JSON.stringify(m));
sendT({ event: 'connected', protocol: 'Call', version: '1.0.0' });
sendT({
  event: 'start', sequenceNumber: '1',
  start: { streamSid: 'MZteststream', callSid: 'CAtestcall123', customParameters: { from: '+13055550100' } },
  streamSid: 'MZteststream',
});
await sleep(150); // let the bridge open the fake OpenAI socket + send session.update
for (let i = 0; i < 3; i++) {
  sendT({ event: 'media', streamSid: 'MZteststream', media: { payload: Buffer.from('caller-audio').toString('base64'), timestamp: String(20 + i * 20) } });
}
await sleep(600); // fake OpenAI drives its scripted conversation
sendT({ event: 'stop', streamSid: 'MZteststream' });
await sleep(400);
tw.close();
await sleep(300);

// --- assertions ---------------------------------------------------------------------------
console.log('\n— fake OpenAI side —');
check('session.update received', !!sessionUpdate);
check('session.type is "realtime" (GA)', sessionUpdate?.type === 'realtime');
check('input format audio/pcmu (g711_ulaw)', sessionUpdate?.audio?.input?.format?.type === 'audio/pcmu');
check('output format audio/pcmu', sessionUpdate?.audio?.output?.format?.type === 'audio/pcmu');
check('server_vad turn detection', sessionUpdate?.audio?.input?.turn_detection?.type === 'server_vad');
check('19 tools + tool_choice auto', sessionUpdate?.tools?.length === 19 && sessionUpdate?.tool_choice === 'auto');
check('instructions mention Marina + Gulf Breeze', /Marina/.test(sessionUpdate?.instructions ?? '') && /Gulf Breeze Air/.test(sessionUpdate?.instructions ?? ''));
check('input transcription enabled', !!sessionUpdate?.audio?.input?.transcription?.model);
check('caller audio appended (input_audio_buffer.append)', oaiReceived.includes('input_audio_buffer.append'));
check('greeting response.create sent', oaiReceived.filter((t) => t === 'response.create').length >= 1);
check('function_call_output sent back', sawFunctionCallOutput);
check('response.create after tool output', sawResponseCreateAfterTool);

console.log('\n— Twilio side —');
check('agent audio streamed to Twilio (media event)', twilioReceived.some((m) => m.event === 'media' && m.media?.payload));
check('barge-in sent Twilio clear', twilioReceived.some((m) => m.event === 'clear'));
check('mark events flow', twilioReceived.some((m) => m.event === 'mark'));

console.log('\n— persistence —');
const call = db.prepare(`SELECT * FROM calls WHERE call_sid = 'CAtestcall123'`).get();
check('call row created on stream start', !!call);
check('from_number stored', call?.from_number === '+13055550100');
check('call finalized (ended_at + status)', !!call?.ended_at && !!call?.status);
const transcripts = db.prepare(`SELECT * FROM call_transcripts WHERE call_id = ? ORDER BY created_at`).all(call.id);
check('caller + agent transcripts persisted', transcripts.length === 2
  && transcripts.some((t) => t.speaker === 'caller') && transcripts.some((t) => t.speaker === 'agent'),
  JSON.stringify(transcripts.map((t) => [t.speaker, t.text])));
const action = db.prepare(`SELECT * FROM agent_actions WHERE call_id = ?`).get(call.id);
check('agent_action persisted', action?.tool === 'find_customer' && JSON.parse(action.result).matches?.length > 0);

console.log('\n— event bus —');
const ev = (n) => busEvents.filter((e) => e.event === n);
check('call.started broadcast', ev('call.started').some((e) => e.payload.call.id === call.id));
check('call.transcript broadcast x2', ev('call.transcript').filter((e) => e.payload.call_id === call.id).length === 2);
check('call.action broadcast w/ summary', ev('call.action').some((e) => e.payload.call_id === call.id && /Searched customer/.test(e.payload.summary)));
check('call.ended broadcast', ev('call.ended').some((e) => e.payload.call.id === call.id));

unsub();
fakeOai.close();

// Leave the dev DB clean: remove this run's call row too (setup only deletes
// rows from PREVIOUS runs).
db.prepare(`DELETE FROM call_transcripts WHERE call_id = ?`).run(call.id);
db.prepare(`DELETE FROM agent_actions WHERE call_id = ?`).run(call.id);
db.prepare(`DELETE FROM calls WHERE id = ?`).run(call.id);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
