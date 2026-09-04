// Marina — the voice agent definition (DESIGN.md §3).
// System prompt + tool schemas, shared by the phone bridge (mediaStream.js),
// the web-call fallback (realtime-token), and later the eval harness.
import { todayEt, utcToEtDate, addDays } from '../lib/time.js';

const WINDOW_ENUM = ['8-10', '10-12', '13-15', '15-17'];

/** Build the system prompt. Called at session start so the date is always fresh. */
export function buildSystemPrompt(now = new Date()) {
  const today = utcToEtDate(now);
  const tomorrow = addDays(today, 1);
  return `You are Marina, the front-desk assistant at Gulf Breeze Air, an HVAC company in Miami, Florida.
You answer the office phone. Speak concisely and warmly, no jargon — this is a phone call, keep every turn short (1–3 sentences).

Context:
- Today's date is ${today} (Eastern Time). Tomorrow is ${tomorrow}.
- Business hours: Monday–Saturday, 8:00 AM–5:00 PM ET. Closed Sundays.
- Arrival windows for appointments: 8–10, 10–12, 1–3 PM, and 3–5 PM (ET).
- Customers are either homeowners or property managers. Property managers (companies) often manage MANY addresses — always pin down which address the call is about before looking things up or booking. Notes and history are per address.

Key behaviors:
1. Identify the caller fast. Ask their name and/or address, then use find_customer. Confirm which customer and which address you're talking about.
2. Answer questions from the data via tools — never from memory. "When were you last out here?" → get_visit_history. "What did the tech do?" → get_visit_history or add detail from notes.
3. Warranty questions → check_warranty. State clearly what is covered and the date basis (e.g. "installed March 3rd 2026, so the 1-year labor warranty runs through March 3rd 2027"). If the data is ambiguous, say so honestly.
4. Book, move, or cancel appointments ONLY after confirming the customer, the address, and the time window aloud with the caller. Read the confirmed booking back before hanging up. Check availability first with check_availability.
5. Emergencies (no cooling with guests arriving, water leaking through the ceiling): prioritize the earliest open slot and offer a handoff to a human dispatcher.
6. Hand off with request_handoff when: the caller disputes billing, is angry, asks for a human, or you cannot resolve their issue after one honest try. Tell them a human will call them back.
7. NEVER invent prices, dates, policies, or availability. Quote only what tools return. If a tool returns nothing or errors, say you don't have that and offer a handoff.
8. You may use get_weather for scheduling-relevant conditions and web_search for facts you don't have (e.g. equipment model numbers).

Always be honest about what you did: if you booked something, say the date and window. If you created a callback task, say so.`;
}

function fn(name, description, properties, required = []) {
  return {
    type: 'function',
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
  };
}

/** Realtime GA tool schemas (RealtimeFunctionTool: type/name/description/parameters). */
export const TOOL_SCHEMAS = [
  fn(
    'find_customer',
    'Search customers by name, company, or address fragment. Returns top matches with their addresses. Use first, on every call, to identify who is calling.',
    { query: { type: 'string', description: 'Name, company name, or address fragment, e.g. "89 Harborlight" or "Smith"' } },
    ['query']
  ),
  fn(
    'get_customer_profile',
    'Customer 360 view: kind (homeowner vs property manager), all addresses, job count, open balance.',
    { customer_id: { type: 'string' } },
    ['customer_id']
  ),
  fn(
    'get_visit_history',
    'Recent service visits for a customer: dates, status, description, techs, and note summaries. Use for "when were you last out" / "what did the tech do".',
    {
      customer_id: { type: 'string' },
      limit: { type: 'integer', description: 'Max visits to return (default 5)' },
    },
    ['customer_id']
  ),
  fn(
    'check_warranty',
    'Warranty verdict for a customer: active 1-year labor warranty from qualifying installs, warranty-tagged jobs, warranty invoice lines, with dates and expiry.',
    { customer_id: { type: 'string' } },
    ['customer_id']
  ),
  fn(
    'get_upcoming_appointments',
    'Scheduled or in-progress future appointments for a customer.',
    { customer_id: { type: 'string' } },
    ['customer_id']
  ),
  fn(
    'check_availability',
    'Open arrival windows on a date. Windows: 8-10, 10-12, 13-15 (1–3 PM), 15-17 (3–5 PM) ET. Only open slots are returned. Closed Sundays.',
    {
      date: { type: 'string', description: 'YYYY-MM-DD' },
      window: { type: 'string', enum: WINDOW_ENUM, description: 'Optional window preference' },
    },
    ['date']
  ),
  fn(
    'book_appointment',
    'Book a new appointment. ONLY call after confirming customer, address, date, and window aloud with the caller. Creates a scheduled job with the best-fit tech.',
    {
      customer_id: { type: 'string' },
      address_id: { type: 'string', description: 'Address id from find_customer / get_customer_profile' },
      date: { type: 'string', description: 'YYYY-MM-DD' },
      window: { type: 'string', enum: WINDOW_ENUM },
      description: { type: 'string', description: 'Short reason for the visit, e.g. "AC not cooling"' },
      notes: { type: 'string', description: 'Optional extra notes for the tech/office' },
    },
    ['customer_id', 'address_id', 'date', 'window']
  ),
  fn(
    'reschedule_appointment',
    'Move an existing appointment to a new date/window. Confirm with the caller first. Keeps the same tech if they are free.',
    {
      job_id: { type: 'string' },
      date: { type: 'string', description: 'YYYY-MM-DD' },
      window: { type: 'string', enum: WINDOW_ENUM },
    },
    ['job_id', 'date', 'window']
  ),
  fn(
    'cancel_appointment',
    'Cancel an appointment. Confirm with the caller first.',
    {
      job_id: { type: 'string' },
      reason: { type: 'string' },
    },
    ['job_id']
  ),
  fn(
    'add_job_note',
    'Add an office-visible note to a job (author: agent). Use for details the office or tech should know.',
    {
      job_id: { type: 'string' },
      note: { type: 'string' },
    },
    ['job_id', 'note']
  ),
  fn(
    'get_weather',
    'Current weather and forecast for a Miami-area city or zip. Useful for attic/roof work and scheduling around storms.',
    {
      city_or_zip: { type: 'string', description: 'City name or zip code; defaults to Miami' },
      date: { type: 'string', description: 'Optional YYYY-MM-DD to get that day\'s forecast' },
    },
    ['city_or_zip']
  ),
  fn(
    'web_search',
    'Search the web for facts you do not have in the system: equipment model numbers, supplier hours, etc. Returns a short answer plus top results.',
    { query: { type: 'string' } },
    ['query']
  ),
  fn(
    'request_handoff',
    'Hand the call off to a human. Creates a task for the office and flags the live call on the dashboard. Use for billing disputes, angry callers, anything you cannot resolve, or when the caller asks for a human.',
    {
      reason: { type: 'string', description: 'Why the handoff is needed, in one sentence' },
      customer_id: { type: 'string', description: 'If the caller is identified' },
    },
    ['reason']
  ),
];

/**
 * GA Realtime session object (verified against developers.openai.com Realtime
 * API reference — session.update / RealtimeSessionCreateRequest, GA shape).
 * audioFormat: 'audio/pcmu' (G.711 μ-law, Twilio's g711_ulaw) for phone calls,
 * or null to leave the default (pcm 24kHz) for browser WebRTC.
 */
export function buildSessionConfig({ audioFormat = 'audio/pcmu' } = {}) {
  const session = {
    type: 'realtime',
    instructions: buildSystemPrompt(),
    tools: TOOL_SCHEMAS,
    tool_choice: 'auto',
    audio: {
      input: {
        transcription: { model: 'whisper-1' },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 600,
          create_response: true,
          interrupt_response: true,
        },
      },
      output: { voice: 'marin' },
    },
  };
  if (audioFormat) {
    session.audio.input.format = { type: audioFormat };
    session.audio.output.format = { type: audioFormat };
  }
  return session;
}
