// Shared helpers for scenarios: date-in-reply matching (LLM wording varies —
// "2026-09-09", "September 9th", "9/9" are all the same fact) and stopword-free
// keyword extraction for "did the reply reference the real data" checks.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** True if `text` mentions the calendar date `iso` ('YYYY-MM-DD') in any common spoken/written form. */
export function mentionsDate(text, iso) {
  if (!text || !iso) return false;
  const [y, m, d] = iso.split('-').map(Number);
  const t = text.toLowerCase();
  if (t.includes(iso)) return true;
  const mon = MONTHS[m - 1].toLowerCase();
  const day = String(d);
  const ordinal = `${d}(st|nd|rd|th)?`;
  if (new RegExp(`\\b${mon}(\\.|\\b)[^\\d]{0,4}\\b${ordinal}\\b`, 'i').test(t)) return true;
  if (new RegExp(`\\b${mon.slice(0, 3)}\\.?\\s+${ordinal}\\b`, 'i').test(t)) return true;
  if (new RegExp(`\\b${m}/${d}(/${y})?\\b`).test(t)) return true;
  return false;
}

const STOP = new Set(['there', 'their', 'about', 'which', 'would', 'could', 'should', 'service', 'repair', 'standard', 'after', 'hours', 'system', 'installation', 'diagnostic', 'dispatch', 'fees']);

/** Distinctive lowercase keywords (len ≥ 5, no stopwords) from a tool-result string. */
export function keywordsOf(s) {
  return [...new Set(String(s ?? '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 5 && !STOP.has(w)))];
}

/** Next business day at least `minAhead` days after `fromDate` (skips Sundays). */
export function businessDay(fromDate, addDays, etDayOfWeek, minAhead) {
  let d = addDays(fromDate, minAhead);
  while (etDayOfWeek(d) === 0) d = addDays(d, 1);
  return d;
}
