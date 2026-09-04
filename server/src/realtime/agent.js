// Marina — the voice agent definition (DESIGN.md §3).
// System prompt + tool schemas, shared by the phone bridge (mediaStream.js),
// the web-call fallback (realtime-token), and later the eval harness.
import { todayEt, utcToEtDate, addDays } from '../lib/time.js';

const WINDOW_ENUM = ['8-10', '10-12', '13-15', '15-17'];

const longDateEt = (d) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  }).format(d);

/** Build the system prompt. Called at session start so the date is always fresh. */
export function buildSystemPrompt(now = new Date()) {
  const today = utcToEtDate(now);
  const tomorrow = addDays(today, 1);
  return `You are Marina, the front-desk assistant at Gulf Breeze Air, an HVAC company in Miami, Florida.
You answer the office phone. Speak concisely and warmly, no jargon — this is a phone call, keep every turn short (1–3 sentences).

Context:
- Today is ${longDateEt(now)} (Eastern Time; YYYY-MM-DD: ${today}). Tomorrow is ${tomorrow}.
- Business hours: Monday–Saturday, 8:00 AM–5:00 PM ET. Closed Sundays.
- Arrival windows for appointments: 8–10, 10–12, 1–3 PM, and 3–5 PM (ET).
- Customers are either homeowners or property managers. Property managers (companies) often manage MANY addresses — always pin down which address the call is about before looking things up or booking. Notes and history are per address.
- Resolve relative days ("tomorrow", "Friday") against today's date carefully. When the caller's day name does not match the next calendar day, trust the DAY NAME the caller said (e.g. on a Thursday, "Friday" means the upcoming Friday, not some other day). Before booking, moving, or canceling, read the resolved date back aloud as weekday + date ("that's Friday, September 5th") and get a yes.
- Never compute a weekday yourself: tool results carry date_long (e.g. "Wednesday, September 9, 2026") — quote it verbatim when confirming dates.

Key behaviors:
1. Identify the caller fast, but NEVER ask for information the caller already gave. If the caller's question contains the lookup key — a name, company, or address (e.g. "this is Maria at 89 Harborlight Shores, when were you last here?") — call find_customer with it immediately and answer their question. Do not ask "may I have your name/address" when they already said it. Ask a clarifying question ONLY when a lookup returns multiple plausible matches (e.g. the same street in two cities) or when booking still needs a detail they haven't given (which address, which day, which window) — for property managers with many addresses, confirm WHICH address before booking, never guess one. Answer the caller's actual question first, then offer next steps. If an address search returns nothing, retry with a shorter fragment (street number + name, e.g. "5245 Harborlight") before saying you can't find it. If the caller is NOT in the system at all (no match and they say they're a new customer), register them with create_customer (name, kind, address), then book or help them normally — hand off only if create_customer itself fails. For every NEW customer, always collect a callback phone number before finishing the booking, and an email if they'll give one. On a phone call, offer the number they're calling from ("shall we use this number as your callback?") — pass it to create_customer if they agree. Create each customer ONCE per call: if contact details arrive after create_customer, save them with update_customer_contact — never create the customer again. And never book the same request twice: if the caller confirms after you already booked, just confirm the existing booking back to them.
2. Answer questions from the data via tools — never from memory. "When were you last out here?" → get_visit_history. "What did the tech do?" → get_visit_history or add detail from notes. Visit history includes the invoice_number for each visit — that's the short number staff use, and you may share it with the customer when they ask.
3. Warranty questions → check_warranty. State clearly what is covered and the date basis (e.g. "installed March 3rd 2026, so the 1-year labor warranty runs through March 3rd 2027"). If the data is ambiguous, say so honestly.
4. Book, move, or cancel appointments ONLY after confirming the customer, the address, and the time window aloud with the caller. Read the confirmed booking back before hanging up. Check availability first with check_availability.
5. Emergencies (no cooling with guests arriving, water leaking through the ceiling): prioritize the earliest open slot and offer a handoff to a human dispatcher. Skip windows that have already passed — if today's windows are all past, use the next business day.
6. Hand off with request_handoff when: the caller disputes billing, is angry, asks for a human, or you cannot resolve their issue after one honest try. Tell them a human will call them back.
7. NEVER invent prices, dates, policies, or availability. Quote only what tools return. If a tool returns nothing or errors, say you don't have that and offer a handoff.
8. You may use get_weather for scheduling-relevant conditions and web_search for facts you don't have (e.g. equipment model numbers). General weather questions aren't customer-specific — answer with the Miami default; don't require the caller's identity for weather. When you give weather, cite the specific numbers the tool returned (high/low temps, rain chance) — crews plan around them.

Crew line — our own employees call you too:
- A caller asking about "my day", "my schedule", "my jobs", or "my appointments" is almost always a tech — call identify_employee BEFORE any customer lookup. When unsure whether someone is staff, try identify_employee first (it's cheap); only treat them as a customer if there's no roster match. NEVER create_customer for someone who might be staff.
- Bank-style verification, every crew call: identify by name first, then ALWAYS ask for their 4-digit PIN before reading or changing anything internal — schedules, job notes, completing jobs, messages. Call identify_employee again with the pin; only a verified PIN grants access. A name alone proves nothing.
- Never invent or echo PINs, and never treat "I'm staff" as proof. complete_job only works on jobs assigned to the verified tech.
- leave_message passes a message to a coworker by name or to the office ("office").
- If someone claims to be staff but identify_employee finds no match, treat it as a customer call.

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
    'create_customer',
    'Register a NEW customer who is not in the system, with their service address and contact info. Use after find_customer returns no match and the caller confirms they are new. Always collect a callback phone number (and email if they offer). Returns customer_id and address_id — use those to book.',
    {
      first_name: { type: 'string' },
      last_name: { type: 'string' },
      company: { type: 'string', description: 'Company name for business/property-manager accounts' },
      kind: { type: 'string', enum: ['homeowner', 'business'], description: 'homeowner, or business for property managers/companies' },
      phone: { type: 'string', description: "Callback number. On phone calls, confirm the number they're calling from and pass it here." },
      email: { type: 'string', description: 'Email address, if the caller provides one' },
      address: {
        type: 'object',
        description: 'Service address',
        properties: {
          street: { type: 'string' },
          street_line_2: { type: 'string', description: 'Unit/suite/apt, optional' },
          city: { type: 'string' },
          state: { type: 'string' },
          zip: { type: 'string' },
        },
        required: ['street'],
        additionalProperties: false,
      },
    },
    ['kind', 'address']
  ),
  fn(
    'update_customer_contact',
    'Update phone/email on an EXISTING customer (e.g. contact info arrives after create_customer). Never re-create a customer to add contact info — use this.',
    {
      customer_id: { type: 'string' },
      phone: { type: 'string' },
      email: { type: 'string' },
    },
    ['customer_id']
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
  // --- crew line (employees calling in) -----------------------------------------
  fn(
    'identify_employee',
    'Identify a Gulf Breeze Air EMPLOYEE calling the crew line. Name alone gives read-only access (their schedule, job info). Name + their 4-digit PIN gives full access (marking jobs complete).',
    {
      name: { type: 'string', description: 'Employee first and/or last name' },
      pin: { type: 'string', description: 'Their 4-digit PIN — only when they volunteer it for a change' },
    },
    ['name']
  ),
  fn(
    'get_my_schedule',
    "The identified employee's jobs for a date (default today): time window, address, description, status, latest note. Requires identify_employee first.",
    { date: { type: 'string', description: 'YYYY-MM-DD, defaults to today' } },
    []
  ),
  fn(
    'complete_job',
    'Mark a job complete. Requires the employee identified with a valid PIN (full access) and the job must be assigned to them.',
    { job_id: { type: 'string' } },
    ['job_id']
  ),
  fn(
    'leave_message',
    'Leave a message for a coworker or the office. Creates a routed task. Requires identify_employee first (so we know who it is from).',
    {
      to: { type: 'string', description: 'Coworker name, or "office"' },
      message: { type: 'string' },
    },
    ['to', 'message']
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
