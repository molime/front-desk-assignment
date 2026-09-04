// Formatting helpers: cents → dollars, UTC → America/New_York, relative times.
const ET = 'America/New_York';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const dateFmt = new Intl.DateTimeFormat('en-US', { timeZone: ET, month: 'short', day: 'numeric', year: 'numeric' });
const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: ET, weekday: 'short', month: 'short', day: 'numeric' });
const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: ET, hour: 'numeric', minute: '2-digit' });
const dateTimeFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: ET, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});

/** cents → "$1,234.56" (null-safe) */
export function money(cents) {
  if (cents == null) return '—';
  return usd.format(cents / 100);
}

export function fmtDate(iso) {
  return iso ? dateFmt.format(new Date(iso)) : '—';
}

export function fmtDay(iso) {
  return iso ? dayFmt.format(new Date(iso)) : '—';
}

export function fmtTime(iso) {
  return iso ? timeFmt.format(new Date(iso)) : '—';
}

export function fmtDateTime(iso) {
  return iso ? dateTimeFmt.format(new Date(iso)) : '—';
}

/** "Aug 12, 10:00 AM – 12:00 PM" style window from a job's scheduled bounds. */
export function fmtWindow(job) {
  if (!job?.scheduled_start) return 'unscheduled';
  return `${fmtTime(job.scheduled_start)} – ${fmtTime(job.scheduled_end)}`;
}

/** "3h 12m" / "45m" / "2d" style age. */
export function relTime(iso) {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  let text;
  if (mins < 1) text = 'just now';
  else if (mins < 60) text = `${mins}m`;
  else if (mins < 60 * 24) text = `${Math.floor(mins / 60)}h ${mins % 60 ? `${mins % 60}m` : ''}`.trim();
  else text = `${Math.floor(mins / (60 * 24))}d`;
  return diff >= 0 ? `${text} ago` : `in ${text}`;
}

/** call duration from started/ended ISOs → "4:32". */
export function fmtDuration(startedAt, endedAt) {
  if (!startedAt || !endedAt) return '—';
  const secs = Math.max(0, Math.round((new Date(endedAt) - new Date(startedAt)) / 1000));
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
}

/** elapsed mm:ss / hh:mm:ss for live timers. */
export function fmtElapsed(sinceIso, now = Date.now()) {
  const secs = Math.max(0, Math.floor((now - new Date(sinceIso).getTime()) / 1000));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

/** +13055551234 → (305) 555-1234 when it looks like a US number. */
export function fmtPhone(num) {
  if (!num) return 'unknown caller';
  const digits = num.replace(/\D/g, '');
  const us = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (us.length === 10) return `(${us.slice(0, 3)}) ${us.slice(3, 6)}-${us.slice(6)}`;
  return num;
}

/** "Ada" "Lovelace" → "Ada Lovelace", falling back to company. */
export function customerName(c) {
  if (!c) return 'Unknown customer';
  const name = `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim();
  return name || c.company || 'Unnamed';
}

export function fullAddress(a) {
  if (!a) return 'No address on file';
  const line1 = [a.street, a.street_line_2].filter(Boolean).join(', ');
  const line2 = [a.city, a.state].filter(Boolean).join(', ');
  return [line1, line2, a.zip].filter(Boolean).join(' · ');
}

/** YYYY-MM-DD of "today" in ET (matches the server's schedule semantics). */
export function todayEt() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: ET, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date());
}

/** add n days to a YYYY-MM-DD string. */
export function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
