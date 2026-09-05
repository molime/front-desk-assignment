# Gulf Breeze Air — Front Desk

A replacement for Gulf Breeze Air's booking bot: **(1) a voice agent** ("Marina") that
answers a real phone call via Twilio + the OpenAI Realtime API, and **(2) a live office
platform** (React) where everything the agent does — bookings, reschedules, notes,
warranty lookups, handoffs — lands on screen while the caller is still on the phone.
One Node.js process serves the telephony webhooks, the media-stream bridge, the REST
API, the live event bus, and the built frontend. SQLite is seeded once from the
read-only `data/*.jsonl` export of the company's field-service software.

## Architecture

```
Caller ──PSTN──► Twilio number ──TwiML──► <Connect><Stream> ──► server /media-stream (WS, g711_ulaw)
                                                                    │
                                          OpenAI Realtime API (gpt-realtime, WebSocket)
                                                                    │
                                                     function calls ─► tool layer ─► SQLite
                                                                    │                     │
                                                                    └─► event bus ──WS──► Platform UI (live)
```

One process, five surfaces:

- **Telephony webhooks** — `POST /twilio/incoming` (TwiML), `POST /twilio/status`
- **Media-stream bridge** — `/media-stream` WebSocket, Twilio ⇄ OpenAI Realtime (μ-law end to end, no transcoding)
- **REST API** — `/api/...` customers, jobs, schedule, availability, calls, tasks
- **Platform event bus** — `/ws` WebSocket broadcast → live dashboard
- **Static hosting** — serves `web/dist` with SPA fallback (production only)

## Quickstart (local dev)

Requires Node 24+. The server boots with zero env vars set; voice features degrade
gracefully without keys.

```bash
npm --prefix server install
npm --prefix web install
npm run seed          # import data/*.jsonl → server/data/gulfbreeze.db (idempotent)
npm run dev           # backend on :8080 (also serves web/dist if it exists)
npm --prefix web run dev   # frontend dev server on :5173 (proxies /api and /ws)
```

Or run the production shape locally:

```bash
npm run build         # web → web/dist
npm start             # one process on :8080 serves API + WS + the SPA
```

### Environment variables (`server/.env`)

Copy `server/.env.example` → `server/.env`. All optional:

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP/WS listen port |
| `PUBLIC_URL` | request Host | Public base URL; builds the `wss://` stream URL in TwiML |
| `OPENAI_API_KEY` | — | Required for the voice agent, web-call token, call summaries |
| `OPENAI_REALTIME_MODEL` | `gpt-realtime` | Realtime speech-to-speech model |
| `OPENAI_SUMMARY_MODEL` | `gpt-4o-mini` | Post-call summary + outcome classification |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | — | Twilio credentials |
| `TWILIO_VALIDATE_SIGNATURE` | `true` | Validate `X-Twilio-Signature` on `/twilio/*` (set `false` for local simulators) |
| `OPENAI_REALTIME_WS_URL` | — | Test-only override of the Realtime WS endpoint |

## Production

### Docker

```bash
docker build -t gba-frontdesk .
docker run --rm -p 8080:8080 \
  -e OPENAI_API_KEY=sk-... \
  -e TWILIO_ACCOUNT_SID=AC... -e TWILIO_AUTH_TOKEN=... \
  -e PUBLIC_URL=https://<your-domain> \
  gba-frontdesk
```

The multi-stage `Dockerfile` builds `web/`, installs server prod deps, and copies
`data/*.jsonl` as the read-only seed source. On first boot with an empty `jobs`
table the server auto-seeds SQLite (`server/data/gulfbreeze.db` inside the
container) — mount a volume at `/app/server/data` to persist it.

### Railway

1. New project → deploy from repo. `railway.json` selects the Dockerfile builder
   and sets the healthcheck to `/api/health`.
2. Set env vars: `OPENAI_API_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
   `PUBLIC_URL` (your `*.up.railway.app` domain).
3. (Optional) attach a volume at `/app/server/data` so the SQLite file survives
   redeploys; without it the DB re-seeds on each boot, which is fine for a demo.

### Twilio console

On your phone number's Voice configuration:

- **A call comes in:** Webhook, `POST https://<app>/twilio/incoming`
- **Status callback:** `https://<app>/twilio/status`

## The agent

Marina answers as Gulf Breeze Air's front desk (Miami HVAC; business hours
Mon–Sat 8:00–17:00 ET). She identifies the caller, answers from the company data
via tools (never from memory), states warranty coverage with its date basis,
books/moves/cancels only after reading the details back aloud, prioritizes
emergencies, hands off to a human when she should, and never invents prices,
dates, or policies. Every tool call is persisted to `agent_actions` — the audit
trail answering "what did it promise anyone?".

**Tools (19):**

- `find_customer` — search by name, company, or address fragment; returns matches with addresses
- `create_customer` — register a new caller (name, address, callback number) and return ids for booking
- `update_customer_contact` — save phone/email on an existing customer without re-creating it
- `get_customer_profile` — customer 360: kind, addresses, job count, open balance
- `get_visit_history` — recent visits with status, dates, techs, note summaries
- `check_warranty` — warranty verdict with dates (1-yr labor warranty, warranty-tagged jobs/lines)
- `get_upcoming_appointments` — scheduled/in-progress future jobs
- `check_availability` — open arrival windows for a date (capacity from assignments; past windows never offered)
- `book_appointment` — create a scheduled job with best-fit tech (broadcasts live)
- `reschedule_appointment` — move date/window, keep the tech if free
- `cancel_appointment` — cancel with a reason note
- `add_job_note` — office-visible note authored by the agent
- `get_weather` — Open-Meteo current/forecast for a Miami-area city or zip
- `web_search` — DuckDuckGo instant answers + top results (model numbers, supplier hours)
- `request_handoff` — create a handoff task and flag the live call on the dashboard
- `identify_employee` — crew line: roster match + 4-digit PIN verification (name alone grants nothing)
- `get_my_schedule` — a verified tech's jobs for a day (window, address, latest human note)
- `complete_job` — a verified tech marks their own job complete
- `leave_message` — a verified tech leaves a routed message for a coworker or the office

Note hygiene: Housecall Pro's automation writes draft artifacts into job notes
(`[AI Auto-Complete … REVIEW BEFORE INVOICING]` letters, `=== AI STATUS FLAGS ===`
blocks). Those are office workflow data, never caller-facing — they're filtered
out of every agent-read path (visit history, crew schedule notes).

**Crew line.** Techs call the same number as customers. Bank-style verification:
a name match alone grants nothing — Marina asks for a 4-digit PIN before reading
anything internal; `get_my_schedule`, `complete_job`, and `leave_message` all
require a verified PIN, and `complete_job` only works on the verified tech's own
jobs. Three wrong PINs lock crew access for the rest of the call. PINs are
derived deterministically per employee (`CREW_PIN_SEED`) so they survive
reseeds/redeploys; the office looks them up locally with
`npm --prefix server run pins` — they are deliberately absent from the dashboard
and the API, which have no auth.

If telephony is unavailable, a **"Call the front desk"** button on the dashboard
uses the Realtime API over browser WebRTC with an ephemeral token
(`POST /api/realtime-token`) — same agent, same tools.

## The platform

React SPA served live over `/ws` (`call.started`, `call.transcript`, `call.action`,
`call.ended`, `job.created`, `job.updated`, `note.added`, `task.created`):

- **Dashboard (`/`)** — today's schedule grid (tech × window), live call panel
  (rolling transcript + action feed as they happen), open handoffs
- **Schedule (`/schedule`)** — week view by tech, job detail drawer
- **Calls (`/calls`, `/calls/:id`)** — transcript, summary, duration, full action audit trail
- **Customers (`/customers`, `/customers/:id`)** — search; 360 view: addresses, history, invoices/balance, warranty badge
- **Jobs (`/jobs/:id`)** — status, schedule, techs, notes (incl. agent notes), invoice line items
- **Tasks (`/tasks`)** — handoff / follow-up queue

## Verification & eval harness

```bash
npm --prefix server run test:tools    # unit: all 19 tools against the real DB
npm --prefix server run test:bridge   # integration: Twilio⇄Realtime bridge vs fake OpenAI + fake Twilio
npm --prefix server run pins          # print crew-line PINs locally (never exposed via API/UI)
node harness/run.js                   # 10 scripted caller scenarios through the real tool layer
node harness/run.js --dry-run         # validate scenarios without an OpenAI key
HARNESS_FAKE_LLM=1 node harness/run.js  # fully deterministic, offline
```

The harness boots the real services + tool implementations against a throwaway
copy of the DB, drives scripted caller turns with the same system prompt and tool
schemas as the voice agent, and asserts tool calls, DB side effects, and forbidden
behaviors (e.g. invented prices).

## Design decisions & tradeoffs

- **SQLite, not Postgres.** Zero-infra, repo-local, reproducible; 2k jobs is
  trivial for it. `data/` stays byte-identical — we import once, never write there.
  Tradeoff: single-writer, no network access — fine for one process on one host.
- **OpenAI Realtime, not STT→LLM→TTS.** One speech-to-speech model with server VAD
  and native function calling gives sub-second latency and barge-in; a Deepgram +
  GPT + ElevenLabs pipeline is more controllable but three vendors to debug and
  worse latency. Twilio's `g711_ulaw` is natively supported, so no transcoding.
- **No auth.** Internal office demo tool; add SSO/RBAC before real exposure.
- **Capacity model:** 4 arrival windows/day (8–10, 10–12, 13–15, 15–17 ET),
  Mon–Sat 8:00–17:00, max 2 jobs per tech per window, computed from
  `job_assignments`. Windows already in the past are never offered or booked
  (same-day cutoff 14:00 ET). Simple and explainable; no travel-time routing.
- **One process for everything.** HTTP + both WS endpoints + static hosting in a
  single Fastify app; trivially deployable as one container. Doesn't scale
  horizontally without sticky sessions/event-bus fanout — irrelevant at this size.
- **Web-call fallback.** Browser WebRTC with ephemeral tokens exercises the exact
  same agent when telephony isn't available (also handy for demos).

## Costs (approximate list prices)

| Item | Approx. cost |
|---|---|
| Twilio phone number (US local) | ~$1.15/month |
| Twilio voice (inbound) | ~$0.014/minute |
| OpenAI Realtime (`gpt-realtime`) | audio input ~$32 / 1M tokens, output ~$64 / 1M tokens — order of $0.05–0.25/minute of call depending on talk ratio |
| Call summaries (`gpt-4o-mini`) | negligible (fractions of a cent per call) |
| Railway hobby instance | ~$5/month |

A typical 3-minute call lands around **$0.35–$0.85 all-in**. Prices are
approximate list prices at submission time — check the vendors' current pricing
pages before budgeting.
