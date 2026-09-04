// REST API (DESIGN.md §7 Stage 1 route list).
import * as customers from '../services/customerService.js';
import * as jobs from '../services/jobService.js';
import * as schedule from '../services/scheduleService.js';
import * as warranty from '../services/warrantyService.js';
import { todayEt } from '../lib/time.js';

const notFound = (reply, msg) => reply.code(404).send({ error: msg });

export default async function apiRoutes(app) {
  app.get('/api/health', async () => ({ status: 'ok', service: 'gulf-breeze-front-desk', time: new Date().toISOString() }));

  // --- customers -------------------------------------------------------------
  app.get('/api/customers', async (req, reply) => {
    const q = req.query.q;
    if (!q || !String(q).trim()) return reply.code(400).send({ error: 'q query param is required' });
    return { results: customers.search(q) };
  });

  app.get('/api/customers/:id', async (req, reply) => {
    const profile = customers.getProfile(req.params.id);
    return profile ?? notFound(reply, 'customer not found');
  });

  app.get('/api/customers/:id/history', async (req, reply) => {
    const limit = Math.min(Number(req.query.limit) || 10, 50);
    const history = customers.getVisitHistory(req.params.id, limit);
    return history ?? notFound(reply, 'customer not found');
  });

  app.get('/api/customers/:id/upcoming', async (req, reply) => {
    if (!customers.getById(req.params.id)) return notFound(reply, 'customer not found');
    return { appointments: customers.getUpcomingAppointments(req.params.id) };
  });

  app.get('/api/customers/:id/warranty', async (req, reply) => {
    const verdict = warranty.checkWarranty(req.params.id);
    return verdict ?? notFound(reply, 'customer not found');
  });

  app.get('/api/customers/:id/invoices', async (req, reply) => {
    const invoices = customers.getInvoices(req.params.id);
    return invoices ? { invoices } : notFound(reply, 'customer not found');
  });

  // --- jobs ------------------------------------------------------------------
  app.get('/api/jobs/:id', async (req, reply) => {
    const job = jobs.getJobDetail(req.params.id);
    return job ?? notFound(reply, 'job not found');
  });

  app.post('/api/jobs', async (req, reply) => {
    const job = jobs.createJob(req.body ?? {});
    return reply.code(201).send(job);
  });

  app.patch('/api/jobs/:id/schedule', async (req, reply) => {
    return jobs.rescheduleJob(req.params.id, req.body ?? {});
  });

  app.post('/api/jobs/:id/cancel', async (req, reply) => {
    return jobs.cancelJob(req.params.id, req.body ?? {});
  });

  app.post('/api/jobs/:id/notes', async (req, reply) => {
    const { content, author } = req.body ?? {};
    const note = jobs.addNote(req.params.id, content, author === 'office' ? 'office' : 'agent');
    return reply.code(201).send(note);
  });

  // --- schedule / availability ------------------------------------------------
  app.get('/api/schedule/today', async () => schedule.getScheduleDay(todayEt()));

  app.get('/api/schedule/week', async (req) => schedule.getScheduleWeek(req.query.start ?? null));

  app.get('/api/availability', async (req) => {
    return schedule.getAvailability(req.query.date, req.query.window ?? null);
  });
}
