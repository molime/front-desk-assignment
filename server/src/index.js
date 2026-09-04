// Gulf Breeze Air front-desk server — one Node process for everything (DESIGN.md §1).
import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyFormbody from '@fastify/formbody';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import apiRoutes from './routes/api.js';
import platformRoutes from './routes/platform.js';
import webcallRoutes from './routes/webcall.js';
import twilioRoutes from './routes/twilio.js';
import wsRoutes from './routes/ws.js';
import mediaStreamRoute from './realtime/mediaStream.js';
import staticRoutes, { hasWebBuild, DIST_DIR } from './routes/static.js';
import config from './config.js';
import db from './db/index.js'; // opens the DB + ensures schema on boot
import { runImport } from './db/import.js';

const app = Fastify({ logger: true });

// Tolerate empty JSON bodies on POST/PATCH (e.g. fetch with a JSON
// content-type header but no payload) instead of a 400.
app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  if (body === '' || body == null) return done(null, {});
  try { done(null, JSON.parse(body)); } catch (err) { err.statusCode = 400; done(err); }
});

// First-boot auto-seed: a fresh container has an empty jobs table → import
// from the read-only data/*.jsonl so the app works with zero manual steps.
const jobCount = db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n;
if (jobCount === 0) {
  app.log.info('jobs table is empty — seeding database from data/*.jsonl');
  const { counts } = runImport();
  app.log.info({ jobs: counts.jobs, customers: counts.customers, invoices: counts.invoices }, 'seed complete');
} else {
  app.log.info({ jobs: jobCount }, 'database already seeded');
}

// JSON 404 + error shaping (before route registration so plugins inherit them).
// When the web build exists, non-API GET paths fall back to index.html so
// client-side routes (/customers, /calls/123, …) load the SPA. /api, /ws,
// /twilio and /media-stream keep the JSON 404 (WS upgrades are handled by
// their own routes, which outrank the static wildcard).
const serveStatic = hasWebBuild();
const RESERVED = /^\/(api|ws|twilio|media-stream)(\/|$)/;
app.setNotFoundHandler((req, reply) => {
  const url = (req.raw.url ?? '').split('?')[0];
  if (serveStatic && req.method === 'GET' && !RESERVED.test(url)) {
    return reply.type('text/html').send(createReadStream(path.join(DIST_DIR, 'index.html')));
  }
  return reply.code(404).send({ error: 'not found' });
});
app.setErrorHandler((err, req, reply) => {
  const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
  if (status === 500) req.log.error(err);
  reply.code(status).send({ error: err.message ?? 'internal error' });
});

await app.register(fastifyFormbody); // Twilio posts application/x-www-form-urlencoded
await app.register(fastifyWebsocket);

await app.register(apiRoutes);
await app.register(platformRoutes);
await app.register(webcallRoutes);
await app.register(twilioRoutes);

// WebSockets (must register after @fastify/websocket):
//   /media-stream — Twilio ⇄ OpenAI Realtime bridge (Stage 2)
//   /ws           — platform event bus broadcast → live dashboard
await app.register(mediaStreamRoute);
await app.register(wsRoutes);

// Production static hosting: serve the built React app + SPA fallback at /.
// Skipped when web/dist doesn't exist (dev mode uses the vite dev server).
if (serveStatic) {
  await app.register(staticRoutes);
  app.log.info(`serving web build from ${DIST_DIR}`);
}

const port = config.port;
try {
  await app.listen({ port, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
