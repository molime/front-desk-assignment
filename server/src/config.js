// Central env config (DESIGN.md §6). Everything optional — the server must boot
// with zero env vars set (dev mode); features degrade gracefully instead.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Load server/.env if present (local dev). In Docker/Railway the file doesn't
// exist and env vars come from the platform — that's fine, keep booting.
try {
  process.loadEnvFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env'));
} catch { /* no .env file — env comes from the shell/platform */ }

const env = process.env;

// Env values pasted into hosting dashboards often arrive with surrounding
// quotes or whitespace — strip them, and never let a malformed value through.
const clean = (v) => {
  const s = (v ?? '').trim().replace(/^["']+|["']+$/g, '');
  return s || null;
};

export const config = {
  port: Number(env.PORT) || 8080,
  // Public base URL of this server (e.g. https://gulfbreeze.up.railway.app).
  // Used to build the wss:// URL in TwiML; falls back to the request host.
  // Must parse as a URL or we ignore it — a malformed value must never 500
  // the phone line (prod incident: quoted PUBLIC_URL broke signature checks).
  publicUrl: (() => {
    const v = clean(env.PUBLIC_URL);
    try { return v ? new URL(v).origin : null; } catch { return null; }
  })(),

  openaiApiKey: clean(env.OPENAI_API_KEY),
  realtimeModel: env.OPENAI_REALTIME_MODEL ?? 'gpt-realtime',
  summaryModel: env.OPENAI_SUMMARY_MODEL ?? 'gpt-4o-mini',

  twilioAccountSid: clean(env.TWILIO_ACCOUNT_SID),
  twilioAuthToken: clean(env.TWILIO_AUTH_TOKEN),
  // Signature validation is ON whenever an auth token is set, unless this is
  // explicitly 'false' (local dev / fake-call testing behind no real Twilio).
  twilioValidateSignature: env.TWILIO_VALIDATE_SIGNATURE !== 'false',

  // Test hook: override the OpenAI Realtime WS endpoint (integration tests
  // point this at a local fake server).
  realtimeWsUrl: env.OPENAI_REALTIME_WS_URL ?? null,
};

export default config;
