// Twilio telephony webhooks (DESIGN.md §3 call lifecycle steps 1 & 4).
// POST /twilio/incoming → TwiML connecting the call to the /media-stream WS.
// POST /twilio/status   → call-status callback; finalizes the call row.
// Twilio posts application/x-www-form-urlencoded; fastify-formbody parses it.
import { createHmac, timingSafeEqual } from 'node:crypto';
import config from '../config.js';
import { getCallBySid, finalizeCall } from '../services/callService.js';
import { broadcast } from '../lib/events.js';

const xmlEscape = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Validate Twilio's X-Twilio-Signature (HMAC-SHA1 of url + sorted POST params,
 * base64). Skipped unless TWILIO_AUTH_TOKEN is set AND TWILIO_VALIDATE_SIGNATURE
 * is not 'false'. Manual implementation — no twilio npm dependency.
 */
function validateTwilioSignature(req) {
  if (!config.twilioAuthToken || !config.twilioValidateSignature) return true;
  const signature = req.headers['x-twilio-signature'];
  if (!signature) return false;

  // Reconstruct the exact URL Twilio requested. PUBLIC_URL wins if set
  // (proxies like Railway rewrite Host), otherwise use the request host.
  const url = config.publicUrl
    ? `${config.publicUrl.replace(/\/$/, '')}${req.raw.url}`
    : `https://${req.headers.host}${req.raw.url}`;

  let data = url;
  for (const key of Object.keys(req.body ?? {}).sort()) {
    data += key + req.body[key];
  }
  const expected = createHmac('sha1', config.twilioAuthToken).update(data, 'utf8').digest('base64');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** wss:// URL for the media stream, from PUBLIC_URL or the request host. */
function mediaStreamUrl(req) {
  if (config.publicUrl) {
    const u = new URL(config.publicUrl);
    return `wss://${u.host}/media-stream`;
  }
  return `wss://${req.headers.host}/media-stream`;
}

export default async function twilioRoutes(app) {
  // Guard both webhooks behind signature validation.
  app.addHook('preHandler', async (req, reply) => {
    if (!validateTwilioSignature(req)) {
      req.log.warn('twilio signature validation failed');
      return reply.code(403).send({ error: 'invalid Twilio signature' });
    }
  });

  app.post('/twilio/incoming', async (req, reply) => {
    const streamUrl = mediaStreamUrl(req);
    const from = req.body?.From ?? null;
    req.log.info({ from, streamUrl }, 'incoming call → connecting media stream');
    // Pass the caller's number into the media stream as a custom parameter so
    // the bridge can store it on the calls row.
    const param = from ? `<Parameter name="from" value="${xmlEscape(from)}" />` : '';
    reply.type('text/xml').send(
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<Response>\n  <Connect>\n    <Stream url="${streamUrl}">\n      ${param}\n    </Stream>\n  </Connect>\n</Response>`
    );
  });

  // If validation fails Twilio falls back here — keep the caller informed.
  app.post('/twilio/fallback', async (_req, reply) => {
    reply.type('text/xml').send(
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<Response><Say>Sorry, Gulf Breeze Air's phone system is having trouble. Please try again shortly.</Say><Hangup/></Response>`
    );
  });

  app.post('/twilio/status', async (req, reply) => {
    const { CallSid, CallStatus } = req.body ?? {};
    req.log.info({ CallSid, CallStatus }, 'twilio status callback');
    if (CallSid && ['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(CallStatus)) {
      const call = getCallBySid(CallSid);
      if (call) {
        const updated = finalizeCall(call.id, { status: CallStatus });
        if (updated && !call.ended_at) {
          broadcast('call.ended', { call: updated });
        }
      }
    }
    return reply.code(204).send();
  });
}
