# Gulf Breeze Air — Front Desk: Design Doc

**Goal:** Replace Gulf Breeze Air's booking bot with (1) a voice agent that answers a real
phone call and (2) a platform the office runs their day from, where everything the agent
does lands live, on screen, while the caller is still on the phone.

**Hard rule:** `data/` is read-only. We import it into our own database once; we never
write into that folder.

---

## 1. Architecture overview

```
Caller ──PSTN──► Twilio number ──TwiML──► <Connect><Stream> ──► server /media-stream (WS, g711_ulaw)
                                                                    │
                                          OpenAI Realtime API (gpt-realtime, WebSocket)
                                                                    │
                                                     function calls ─► tool layer ─► SQLite
                                                                    │                     │
                                                                    └─► event bus ──WS──► Platform UI (live)
```

One Node.js process serves everything:

- **Telephony webhooks** (`/twilio/incoming`, `/twilio/status`)
- **Media-stream bridge** (`/media-stream` WebSocket) — Twilio ⇄ OpenAI Realtime
- **REST API** (`/api/...`) — customers, jobs, schedule, calls, agent actions, tasks
- **Platform event bus** (`/ws` WebSocket) — pushes live events to the UI
- **Static hosting** — serves the built React app

Single `Dockerfile` builds the frontend and runs the server → deploy on Railway.
SQLite file lives on a mounted volume (or ephemeral disk for the demo window).

### Stack choices (and why)

| Piece | Choice | Why |
|---|---|---|
| Voice transport | Twilio Voice + Media Streams | Real US number anyone can dial; g711_ulaw is natively supported by OpenAI Realtime — no transcoding |
| Voice AI | OpenAI Realtime API (`gpt-realtime`) | Speech-to-speech, server VAD, native function calling, sub-second latency |
| Backend | Node 24, Fastify 5, `ws` | One process for HTTP + 2 WS endpoints; minimal deps |
| DB | SQLite via `better-sqlite3` | Zero-infra, perfect for 2k jobs; import from JSONL keeps `data/` pristine |
| Frontend | React 19 + Vite + Tailwind 4 | Fast build, static output served by the backend |
| Live updates | WebSocket broadcast bus | "See it land on the screen while still on the phone" |
| Web tools | Open-Meteo (weather, keyless) + DuckDuckGo (search, keyless) | Free, no extra keys |
| Harness | Node script driving the real tool layer with the same system prompt/tools | Deterministic scenario tests, the "harness" talking point |

### Alternatives considered

- **STT→LLM→TTS pipeline** (Deepgram + GPT-4o + ElevenLabs): more control, worse latency,
  3 vendors to debug. Realtime API wins for a 48h build.
- **Vapi/Retell managed voice**: faster start, but hides the interesting engineering and
  makes custom tool/platform integration shallower. We own the bridge instead.
- **Postgres**: overkill; SQLite is a feature here (repo-local, reproducible).

---

## 2. Data model

### Imported (read-only source → SQLite)

- `customers` (id, first_name, last_name, company, kind, tags, job_count, first_job, last_job)
- `customer_addresses` (id, customer_id, street, street_line_2, city, state, zip, lat, lng)
- `employees` (id, first_name, last_name, role, job_count)
- `jobs` (id, invoice_number, description, work_status, on_my_way_at, started_at,
  completed_at, scheduled_start, scheduled_end, time_zone, arrival_window, tags JSON,
  total_amount, outstanding_balance, customer_id, address_id, created_at, source = 'import' | 'agent')
- `job_assignments` (job_id, employee_id)
- `job_notes` (id, job_id, content, author = 'import' | 'agent' | 'office', created_at)
- `invoices` (id, job_id, invoice_number, status, amount, subtotal, due_amount, paid_at,
  sent_at, service_date, invoice_date)
- `invoice_items` (id, invoice_id, name, type, unit_price, qty_in_hundredths, amount)

### New (platform/agent)

- `calls` (id, call_sid, from_number, started_at, ended_at, status, summary, outcome,
  handoff_reason)
- `call_transcripts` (id, call_id, speaker 'agent'|'caller', text, created_at)
- `agent_actions` (id, call_id, tool, args JSON, result JSON, created_at) — **the audit
  trail**: answers "I have no idea what it promised anyone"
- `tasks` (id, kind 'handoff'|'followup', title, detail, call_id, job_id, customer_id,
  status 'open'|'done', created_at)

All datetimes UTC ISO strings; money in cents (matching source).

---

## 3. The voice agent

### Persona & instructions (system prompt)

"Marina", front-desk assistant for Gulf Breeze Air, Miami HVAC. Business hours
Mon–Sat 8:00–17:00 ET. Speaks concise, warm, no jargon. Key behaviors:

1. **Identify the caller context fast.** Ask name and/or address; use `find_customer`.
   Property managers (companies) may manage many addresses — always pin the address.
2. **Answer from the data** via tools, never from memory. "When were you last out there"
   → `get_visit_history`.
3. **Warranty logic** via `check_warranty`: installs tagged `1 Yr Labor Warranty` /
   `Registration Complete`, `WARRANTY Parts/Service` invoice lines, `Warranty Claim`
   history. State what's covered and the date basis; if ambiguous, say so.
4. **Book/move/cancel** only after confirming customer, address, and time window aloud.
   Read back the booking before hanging up.
5. **Emergencies** (no cooling with guests arriving, water leaking through ceiling):
   prioritize earliest slot, offer handoff.
6. **Hand off** (`request_handoff`) for: billing disputes, angry callers, anything it
   can't resolve after one honest try, caller asks for a human. Creates a task + flags
   the live call on the dashboard.
7. **Never invent** prices, dates, or policies. Quote only what tools return.
8. Keep turns short; this is a phone call.

### Tools (function calling → REST-equivalent service layer)

| Tool | Purpose |
|---|---|
| `find_customer(query)` | Search customers by name, company, phone-ish, or address fragment. Returns top matches with addresses |
| `get_customer_profile(customer_id)` | Customer 360: kind, addresses, job_count, open balance |
| `get_visit_history(customer_id \| address, limit)` | Recent jobs w/ status, dates, techs, note summaries |
| `check_warranty(customer_id \| address)` | Warranty verdict: active labor warranty (1yr from qualifying install), warranty-tagged jobs, warranty invoice lines, with dates |
| `get_upcoming_appointments(customer_id)` | Scheduled/in-progress future jobs |
| `check_availability(date, window_pref?)` | Open arrival windows per day (8–10, 10–12, 13–15, 15–17 ET), tech capacity 2 jobs per window, from assignments |
| `book_appointment(customer_id, address_id, date, window, description, notes)` | Creates scheduled job + best-fit tech, broadcasts live |
| `reschedule_appointment(job_id, date, window)` | Moves schedule, keeps tech if free |
| `cancel_appointment(job_id, reason)` | Cancels with note |
| `add_job_note(job_id, note)` | Office-visible note, author 'agent' |
| `get_weather(city_or_zip, date?)` | Open-Meteo forecast/current for Miami area |
| `web_search(query)` | DuckDuckGo instant answers + top results (model numbers, supplier hours) |
| `request_handoff(reason)` | Creates handoff task, flags live call, tells caller a human will call back |

### Call lifecycle

1. Twilio inbound → `/twilio/incoming` returns TwiML `<Connect><Stream url="wss://…/media-stream">`
2. Bridge opens OpenAI Realtime session (g711_ulaw both ways, server VAD, tools, prompt),
   streams audio both directions.
3. Every transcript line → `call_transcripts` + WS event. Every function call →
   `agent_actions` + WS event → **dashboard updates live**.
4. Hangup → status webhook → call row finalized with an LLM-generated summary.

### Web-call fallback

If telephony fails, a browser "Call the front desk" button on the platform uses the
Realtime API WebRTC path with an ephemeral token (`/api/realtime-token`) — same agent,
same tools. (Allowed fallback per the brief; also a great demo tool.)

---

## 4. The platform

React SPA, dark-on-light office tool aesthetic, Tailwind. Live via `/ws` events:
`call.started`, `call.transcript`, `call.action`, `call.ended`, `job.created`,
`job.updated`, `note.added`, `task.created`.

- **Dashboard (`/`)** — today's schedule (tech × time grid), **live call panel**
  (ringing indicator, rolling transcript, action feed as they happen), open handoffs.
- **Schedule (`/schedule`)** — week view by tech; click a job → detail drawer.
- **Calls (`/calls`, `/calls/:id`)** — every call the agent took: transcript, summary,
  duration, and the full **action audit trail** (what it promised).
- **Customers (`/customers`, `/customers/:id`)** — search; 360 view: addresses, visit
  history, invoices/balance, warranty badge.
- **Jobs (`/jobs/:id`)** — status, schedule, assigned techs, notes (incl. agent notes),
  invoice with line items.
- **Tasks (`/tasks`)** — handoff/follow-up queue.

Auth: none (internal demo tool; noted as tradeoff in README).

---

## 5. Eval harness

`harness/` — scenario runner, `npm run harness`:

- Boots the real service layer + tool implementations against a **throwaway copy** of the DB.
- Drives scripted caller turns through a text LLM (gpt-4o-mini) with the **same system
  prompt and tool schemas** as the voice agent.
- Asserts: expected tool(s) called, expected DB side effects (job created/moved, note
  written, task opened), and no forbidden behavior (e.g., quoting invented prices).
- Scenarios: (1) "last visit at 89 Harborlight Shores", (2) warranty question on a
  recent install, (3) property-manager emergency booking w/ availability, (4) reschedule,
  (5) tech asking what was done last time, (6) billing dispute → handoff, (7) weather for
  an attic job, (8) unknown model number → web search.
- Prints pass/fail report with diffs. This is the artifact for the "talk about the
  harness" part of the call.

---

## 6. Deployment

- `Dockerfile`: multi-stage — build `web/` → runtime image with `server/` + built assets.
- Railway: Dockerfile auto-detect; env vars `OPENAI_API_KEY`, `TWILIO_*`, `PUBLIC_URL`.
- Twilio console: number voice webhook → `https://<app>/twilio/incoming` (POST).
- `npm run seed` runs import at container start if DB missing.

---

## 7. Implementation stages

### Stage 1 — Foundation: DB + API (backend core)
- [ ] Repo scaffold: `server/` (Fastify 5 + ws), root package.json workspaces, .gitignore, git init
- [ ] `server/src/db/schema.sql` — full schema from §2
- [ ] `server/src/db/import.js` — JSONL → SQLite importer (idempotent, reads `../data`, never writes)
- [ ] `server/src/db/index.js` — connection + query helpers
- [ ] `server/src/services/` — customerService, jobService, scheduleService (availability), warrantyService
- [ ] REST API: `GET /api/health`, `/api/customers?q=`, `/api/customers/:id`,
  `/api/customers/:id/history`, `/api/customers/:id/warranty`, `/api/jobs/:id`,
  `/api/schedule/today`, `/api/schedule/week?start=`, `/api/availability?date=`,
  `POST /api/jobs` (book), `PATCH /api/jobs/:id/schedule` (reschedule),
  `POST /api/jobs/:id/cancel`, `POST /api/jobs/:id/notes`
- [ ] Availability engine: windows 8–10/10–12/13–15/15–17 ET, Mon–Sat, tech capacity 2/window
- [ ] Smoke tests via curl script; import verified (1,992 jobs, 732 customers, 1,700 invoices, 23 employees)

### Stage 2 — Voice agent
- [ ] `/twilio/incoming` TwiML + `/twilio/status` callback
- [ ] `/media-stream` bridge: Twilio ⇄ OpenAI Realtime (g711_ulaw, server VAD, barge-in)
- [ ] `agent.js`: system prompt + tool schemas (per §3)
- [ ] `tools.js`: every tool implemented on the Stage-1 services; weather (Open-Meteo) + web search (DuckDuckGo)
- [ ] Calls/transcripts/agent_actions persistence + event bus broadcasts
- [ ] Call summary on hangup (gpt-4o-mini)
- [ ] Web-call fallback: `/api/realtime-token` ephemeral token endpoint
- [ ] Local verification: simulated stream + harness-style scripted call; real call once Twilio number is live

### Stage 3 — Platform frontend
- [ ] Vite + React + Tailwind scaffold, router, layout/nav, API client + WS hook
- [ ] Dashboard: today's schedule grid, live call panel, handoff list
- [ ] Schedule week view by tech
- [ ] Calls list + call detail (transcript, summary, action audit trail)
- [ ] Customers search + 360 detail (history, invoices, warranty badge)
- [ ] Job detail drawer/page (notes incl. agent-authored, invoice line items)
- [ ] Tasks queue
- [ ] Web-call button (Stage 2 dependency) wired on dashboard

### Stage 4 — Integration & live polish
- [ ] WS event bus end-to-end: action during a call → visible on dashboard without refresh
- [ ] Agent-created jobs render distinctly (badge "booked by Marina")
- [ ] Latency tuning: VAD thresholds, tool-result brevity, greeting immediacy
- [ ] Error paths: tool failure → agent says it will hand off; Twilio disconnect cleanup

### Stage 5 — Eval harness
- [ ] `harness/` runner + assertion library (tool-call expectations, DB state)
- [ ] 8 scripted scenarios per §5
- [ ] `npm run harness` green; sample output committed

### Stage 6 — Ship
- [ ] Dockerfile + .dockerignore; Railway deploy; env vars set
- [ ] Twilio number purchased, webhook pointed, live test call end-to-end
- [ ] README: architecture, how to run, costs, tradeoffs, harness walkthrough
- [ ] 24h liveness check plan; submission reply (number, URL, repo)

---

## 8. Repo layout

```
front-desk-assignment/
├── ASSIGNMENT.md / ASSIGNMENT.docx   # the brief (given)
├── DESIGN.md                          # this doc
├── README.md                          # how to run, costs, tradeoffs
├── data/                              # GIVEN — read-only, never modified
├── server/                            # Node backend (Fastify + ws + better-sqlite3)
│   └── src/{db,routes,services,realtime,lib}
├── web/                               # React + Vite + Tailwind platform
├── harness/                           # eval harness
└── Dockerfile                         # one container: build web, run server
```
