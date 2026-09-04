// America/New_York time helpers using Intl (no tz dependency).
// Business hours and arrival windows are defined in ET; the DB stores UTC.

export const TZ = 'America/New_York';

const dtfParts = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

const dtfDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
});

/** Offset (ms) of ET local time vs UTC at the given UTC instant. */
function etOffsetMs(utcDate) {
  const parts = Object.fromEntries(
    dtfParts.formatToParts(utcDate).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value])
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - utcDate.getTime();
}

/** 'YYYY-MM-DD' + ET wall-clock hour/minute → UTC ISO string. */
export function etToUtc(dateStr, hour = 0, minute = 0) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const localMs = Date.UTC(y, mo - 1, d, hour, minute);
  let utcMs = localMs - etOffsetMs(new Date(localMs));
  utcMs = localMs - etOffsetMs(new Date(utcMs)); // second pass for DST edge
  return new Date(utcMs).toISOString();
}

/** UTC ISO string (or Date) → ET calendar date 'YYYY-MM-DD'. */
export function utcToEtDate(isoOrDate) {
  return dtfDate.format(isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate));
}

/** ET day-of-week for a 'YYYY-MM-DD' ET date (0=Sun … 6=Sat). */
export function etDayOfWeek(dateStr) {
  return new Date(etToUtc(dateStr, 12)).getUTCDay();
}

/** Today in ET, 'YYYY-MM-DD'. */
export function todayEt() {
  return utcToEtDate(new Date());
}

/** Add n days to a 'YYYY-MM-DD' date string. */
export function addDays(dateStr, n) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d + n)).toISOString().slice(0, 10);
}

export function isValidDateStr(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}
