// Central env config (DESIGN.md §6). Everything optional — the server must boot
// with zero env vars set (dev mode); features degrade gracefully instead.
const env = process.env;

export const config = {
  port: Number(env.PORT) || 8080,
  // Public base URL of this server (e.g. https://gulfbreeze.up.railway.app).
  // Used to build the wss:// URL in TwiML; falls back to the request host.
  publicUrl: env.PUBLIC_URL ?? null,

  openaiApiKey: env.OPENAI_API_KEY ?? null,
  realtimeModel: env.OPENAI_REALTIME_MODEL ?? 'gpt-realtime',
  summaryModel: env.OPENAI_SUMMARY_MODEL ?? 'gpt-4o-mini',

  twilioAccountSid: env.TWILIO_ACCOUNT_SID ?? null,
  twilioAuthToken: env.TWILIO_AUTH_TOKEN ?? null,
  // Signature validation is ON whenever an auth token is set, unless this is
  // explicitly 'false' (local dev / fake-call testing behind no real Twilio).
  twilioValidateSignature: env.TWILIO_VALIDATE_SIGNATURE !== 'false',

  // Test hook: override the OpenAI Realtime WS endpoint (integration tests
  // point this at a local fake server).
  realtimeWsUrl: env.OPENAI_REALTIME_WS_URL ?? null,
};

export default config;
