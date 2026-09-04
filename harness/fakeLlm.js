// Deterministic fake LLM for HARNESS_FAKE_LLM=1 — proves the full harness loop
// (tool dispatch → real tool implementations → DB assertions → report → exit
// codes) without an OpenAI key. Keyed off scenario name; each step decides its
// next reply from the tool results already in the transcript, so it exercises
// the same multi-hop path the real model would (ids come from tool results,
// never hardcoded).

/** Canned fixtures for the keyless web tools, used only when a real call errors offline. */
export function webFixture(name, args) {
  if (name === 'get_weather') {
    return {
      location: 'Miami, Florida, United States',
      current: { conditions: 'partly cloudy', temp_f: 88.1, feels_like_f: 96.3, humidity_pct: 74, wind_mph: 8.2 },
      forecast: { date: args.date ?? 'unknown', conditions: 'violent rain showers', high_f: 89.4, low_f: 77.2, rain_chance_pct: 55, max_wind_mph: 14.1 },
    };
  }
  return {
    query: args.query,
    results: [
      {
        title: 'Trane 4TWR5 product data',
        snippet: 'The Trane 4TWR5 is a single-stage heat pump (XR15 family), up to 16 SEER, available in 1.5–5 ton sizes.',
        url: 'https://example.invalid/trane-4twr5',
      },
    ],
  };
}

/** Rebuild [{name, args, result}] from a chat-completions transcript. */
function priorToolCalls(messages) {
  const out = [];
  const pending = new Map();
  for (const m of messages) {
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) {
        pending.set(tc.id, { name: tc.function.name, args: JSON.parse(tc.function.arguments || '{}') });
      }
    }
    if (m.role === 'tool' && pending.has(m.tool_call_id)) {
      const t = pending.get(m.tool_call_id);
      pending.delete(m.tool_call_id);
      out.push({ ...t, result: JSON.parse(m.content) });
    }
  }
  return out;
}

const tc = (name, args) => ({ content: '', toolCalls: [{ name, args }], raw: null });
const say = (content) => ({ content, toolCalls: [], raw: null });

/** Next business day at least `minAhead` days out (skips Sundays — shop is closed). */
function businessDay(todayEt, addDays, etDayOfWeek, minAhead) {
  let d = addDays(todayEt(), minAhead);
  while (etDayOfWeek(d) === 0) d = addDays(d, 1);
  return d;
}

const findMatch = (prior, pred) => prior.find((t) => t.name === 'find_customer')?.result?.matches?.find(pred);

// --- s10 crew fixture ------------------------------------------------------------
// Same deterministic selection as scenarios/s10-crew-line.js (that file builds
// its caller turns from the DB; the fake must mirror it). fakeLlm is only
// imported by run-one.js inside the per-scenario child process, where
// GBA_DB_PATH points at the throwaway copy.
const { default: fdb } = await import('../server/src/db/index.js');
const fEmp = await import('../server/src/services/employeeService.js');
const { todayEt: fTodayEt, addDays: fAddDays, etToUtc: fEtToUtc } = await import('../server/src/lib/time.js');

let crewCache = null;
function crewFixture() {
  if (crewCache) return crewCache;
  fEmp.ensureEmployeePins();
  // Same nearest-day-with-jobs selection as scenarios/s10-crew-line.js.
  let picked = null;
  for (let i = 0; i < 7 && !picked; i++) {
    const date = fAddDays(fTodayEt(), i);
    const tech = fdb
      .prepare(
        `SELECT e.id, e.first_name, e.last_name, COUNT(*) AS n
         FROM employees e
         JOIN job_assignments ja ON ja.employee_id = e.id
         JOIN jobs j ON j.id = ja.job_id
         WHERE e.role = 'field tech' AND j.work_status IN ('scheduled','in progress')
           AND j.scheduled_start >= ? AND j.scheduled_start < ?
         GROUP BY e.id ORDER BY n DESC, e.last_name LIMIT 1`
      )
      .get(fEtToUtc(date, 0), fEtToUtc(fAddDays(date, 1), 0));
    if (tech) picked = { date, tech };
  }
  const { date, tech } = picked;
  const coworker = fdb
    .prepare(`SELECT id, first_name, last_name FROM employees WHERE id != ? AND first_name != 'Team' ORDER BY last_name LIMIT 1`)
    .get(tech.id);
  crewCache = {
    techName: `${tech.first_name} ${tech.last_name}`,
    pin: fEmp.getPin(tech.id),
    coworkerName: `${coworker.first_name} ${coworker.last_name}`,
    date,
  };
  return crewCache;
}

export function makeFakeLlm(scenarioName, { todayEt, addDays, etDayOfWeek }) {
  const state = {}; // per-scenario scratch (e.g. s10's asked-for-PIN step)
  const scripts = {
    's1-last-visit': (prior) => {
      if (!prior.some((t) => t.name === 'find_customer')) return tc('find_customer', { query: '89 Harborlight Shores' });
      if (!prior.some((t) => t.name === 'get_visit_history')) {
        const m = findMatch(prior, (x) => x.addresses.some((a) => /89\s+Harborlight/i.test(a.address)));
        return tc('get_visit_history', { customer_id: m.customer_id, limit: 5 });
      }
      const v = prior.find((t) => t.name === 'get_visit_history').result.visits[0];
      return say(`We were last out at 89 Harborlight Shores on ${v.date} — the visit was "${v.description}"${v.notes?.[0] ? `, and the tech noted: ${v.notes[0]}` : ''}. Anything else I can help with?`);
    },

    's2-warranty': (prior) => {
      if (!prior.some((t) => t.name === 'find_customer')) return tc('find_customer', { query: 'Felix Anders' });
      if (!prior.some((t) => t.name === 'check_warranty')) {
        const m = findMatch(prior, (x) => /Felix/i.test(x.name ?? ''));
        return tc('check_warranty', { customer_id: m.customer_id });
      }
      const w = prior.find((t) => t.name === 'check_warranty').result;
      const inst = w.labor_warranty.installs[0];
      return say(
        w.labor_warranty.active
          ? `Good news — you're covered. The system was installed ${inst.installed_date}, so the one-year labor warranty runs through ${inst.expires_date}.`
          : `I checked — the labor warranty from the ${inst.installed_date} install expired ${inst.expires_date}, so this would be a standard paid visit.`
      );
    },

    's3-emergency-booking': (prior) => {
      if (!prior.some((t) => t.name === 'find_customer')) return tc('find_customer', { query: 'Lighthouse Hospitality' });
      const m = findMatch(prior, (x) => /Lighthouse/i.test(x.company ?? x.name ?? ''));
      const availCalls = prior.filter((t) => t.name === 'check_availability');
      const booked = prior.find((t) => t.name === 'book_appointment');
      if (booked) {
        return say(`You're all set — a tech is booked for ${booked.result.date}, arrival window ${booked.args.window} ET. ${booked.result.techs?.[0] ?? 'A tech'} will be there well before your 4 PM check-ins.`);
      }
      const last = availCalls.at(-1);
      if (!last || last.result.closed || (last.result.open_windows ?? []).length === 0) {
        const nextDate = last ? businessDay(() => last.args.date, addDays, etDayOfWeek, 1) : todayEt();
        if (availCalls.length >= 3) return tc('request_handoff', { reason: 'No open window for an emergency no-cooling call', customer_id: m.customer_id });
        return tc('check_availability', { date: nextDate });
      }
      const win = last.result.open_windows[0].window;
      return tc('book_appointment', {
        customer_id: m.customer_id,
        address_id: m.addresses[0].address_id,
        date: last.result.date,
        window: win,
        description: 'No cooling — guests checking in at 4 PM',
        notes: 'Emergency: property manager, guests checking in at 4 PM. Prioritize.',
      });
    },

    's4-reschedule': (prior, h) => {
      if (!prior.some((t) => t.name === 'find_customer')) return tc('find_customer', { query: 'Jasmine Harrington' });
      const m = findMatch(prior, (x) => /Jasmine/i.test(x.name ?? ''));
      if (!prior.some((t) => t.name === 'get_upcoming_appointments')) return tc('get_upcoming_appointments', { customer_id: m.customer_id });
      const target = businessDay(h.todayEt, h.addDays, h.etDayOfWeek, 5);
      if (!prior.some((t) => t.name === 'check_availability')) return tc('check_availability', { date: target, window: '13-15' });
      if (!prior.some((t) => t.name === 'reschedule_appointment')) {
        const appts = prior.find((t) => t.name === 'get_upcoming_appointments').result.appointments;
        const job = appts.find((a) => /Harness reschedule marker/.test(a.description ?? '')) ?? appts[0];
        return tc('reschedule_appointment', { job_id: job.job_id, date: target, window: '13-15' });
      }
      const r = prior.find((t) => t.name === 'reschedule_appointment');
      return say(`Done — your appointment is moved to ${r.result.date}, arrival window 1–3 PM. ${r.result.techs?.[0] ?? 'A tech'} will see you then.`);
    },

    's5-visit-notes': (prior) => {
      if (!prior.some((t) => t.name === 'find_customer')) return tc('find_customer', { query: '932 Jacaranda Hollow' });
      if (!prior.some((t) => t.name === 'get_visit_history')) {
        const m = findMatch(prior, (x) => x.addresses.some((a) => /932\s+Jacaranda/i.test(a.address) && /Miami Beach/i.test(a.address)));
        return tc('get_visit_history', { customer_id: m.customer_id, limit: 5 });
      }
      const visits = prior.find((t) => t.name === 'get_visit_history').result.visits;
      const v = visits.find((x) => x.notes?.length) ?? visits[0];
      return say(`Last visit there was ${v.date} (${v.description}). Key note from the file: ${v.notes?.[0] ?? 'none on record'}.`);
    },

    's6-billing-dispute': (prior) => {
      if (!prior.some((t) => t.name === 'find_customer')) return tc('find_customer', { query: 'Isabel Kane' });
      const m = findMatch(prior, (x) => /Isabel/i.test(x.name ?? ''));
      if (!prior.some((t) => t.name === 'get_customer_profile')) return tc('get_customer_profile', { customer_id: m.customer_id });
      if (!prior.some((t) => t.name === 'request_handoff')) {
        return tc('request_handoff', {
          reason: 'Customer Isabel Kane angrily disputes an open invoice — says she already paid. Billing dispute, needs a human.',
          customer_id: m.customer_id,
        });
      }
      return say(`I completely understand the frustration, and I'm not going to argue billing over the phone. I've flagged this for our office — a human will call you back today to sort out the invoice.`);
    },

    's7-attic-weather': (prior, h) => {
      if (!prior.some((t) => t.name === 'get_weather')) {
        return tc('get_weather', { city_or_zip: 'Miami', date: h.addDays(h.todayEt(), 1) });
      }
      const f = prior.find((t) => t.name === 'get_weather').result.forecast;
      return say(
        `Tomorrow in Miami: high of ${f.high_f}°F, low ${f.low_f}°F, ${f.rain_chance_pct}% chance of rain, winds up to ${f.max_wind_mph} mph — ${f.conditions}. ` +
          `If the crew starts in the attic at 8 AM they beat the worst of the heat; I'd keep the attic work to the morning.`
      );
    },

    's8-unknown-model': (prior) => {
      if (!prior.some((t) => t.name === 'web_search')) return tc('web_search', { query: 'Trane 4TWR5 heat pump model specs' });
      const call = prior.find((t) => t.name === 'web_search');
      const r = call.result.results?.[0];
      return say(`I looked up the ${call.args.query}: ${r?.snippet ?? 'no details found'} — anything else about the unit I can check?`);
    },

    's9-new-customer-booking': (prior, h) => {
      if (!prior.some((t) => t.name === 'find_customer')) return tc('find_customer', { query: 'Rachel Fontaine' });
      if (!prior.some((t) => t.name === 'create_customer')) {
        return tc('create_customer', {
          first_name: 'Rachel',
          last_name: 'Fontaine',
          kind: 'homeowner',
          phone: '305-555-0142',
          email: 'rachel@fontaine.example',
          address: { street: '7700 Bayshore Colony Drive', city: 'Miami', state: 'FL', zip: '33138' },
        });
      }
      const created = prior.find((t) => t.name === 'create_customer').result;
      const availCalls = prior.filter((t) => t.name === 'check_availability');
      if (!availCalls.length) {
        return tc('check_availability', { date: businessDay(h.todayEt, h.addDays, h.etDayOfWeek, 1), window: '8-10' });
      }
      const booked = prior.find((t) => t.name === 'book_appointment');
      if (booked) {
        return say(`You're all set, Rachel — booked for ${booked.result.date}, arrival window 8–10 AM. ${booked.result.techs?.[0] ?? 'A tech'} will come to 7700 Bayshore Colony Drive. Welcome to Gulf Breeze Air!`);
      }
      const last = availCalls.at(-1);
      if (last.result.closed || (last.result.open_windows ?? []).length === 0) {
        return tc('check_availability', { date: businessDay(() => last.args.date, h.addDays, h.etDayOfWeek, 1), window: '8-10' });
      }
      return tc('book_appointment', {
        customer_id: created.customer_id,
        address_id: created.address_id,
        date: last.result.date,
        window: last.result.open_windows[0].window,
        description: 'AC blowing warm air',
        notes: 'New customer registered by Marina on this call.',
      });
    },

    's10-crew-line': (prior, h) => {
      const crew = crewFixture();
      const ids = prior.filter((t) => t.name === 'identify_employee');
      // PIN-first flow: name alone grants nothing.
      if (!ids.length) {
        return tc('identify_employee', { name: crew.techName });
      }
      if (!ids.some((t) => t.args.pin && !t.result?.error)) {
        if (!state.askedPin) {
          state.askedPin = true;
          return say(`Thanks ${crew.techName.split(' ')[0]} — before I pull up anything internal, could you give me your 4-digit PIN?`);
        }
        return tc('identify_employee', { name: crew.techName, pin: crew.pin });
      }
      if (!prior.some((t) => t.name === 'get_my_schedule')) {
        return tc('get_my_schedule', { date: crew.date });
      }
      const sched = prior.find((t) => t.name === 'get_my_schedule').result;
      const jobId = sched.jobs[0]?.job_id;
      const completes = prior.filter((t) => t.name === 'complete_job');
      if (!completes.some((t) => !t.result?.error)) return tc('complete_job', { job_id: jobId });
      if (!prior.some((t) => t.name === 'leave_message')) {
        return tc('leave_message', { to: crew.coworkerName, message: 'the capacitor came in' });
      }
      return say(`Done — your first job is marked complete, and I've left the message for ${crew.coworkerName}: the capacitor came in.`);
    },
  };

  const script = scripts[scenarioName];
  if (!script) throw new Error(`fake LLM has no script for scenario "${scenarioName}"`);
  const helpers = { todayEt, addDays, etDayOfWeek };
  return async (messages) => script(priorToolCalls(messages), helpers);
}
