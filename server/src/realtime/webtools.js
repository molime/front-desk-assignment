// Keyless web tools for the agent: Open-Meteo weather + DuckDuckGo search
// (DESIGN.md §3 get_weather / web_search). All fetches carry timeouts and
// return {error} instead of throwing — a broken tool must never kill a call.

const TIMEOUT_MS = 6000;

async function fetchJson(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'user-agent': 'gulf-breeze-front-desk/0.1' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; gulf-breeze-front-desk/0.1)' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.text();
}

// --- get_weather -------------------------------------------------------------

const MIAMI = { name: 'Miami', lat: 25.7617, lng: -80.1918 };

const WMO_CODES = {
  0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'fog', 48: 'depositing rime fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'dense drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain',
  66: 'freezing rain', 67: 'heavy freezing rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains',
  80: 'light rain showers', 81: 'rain showers', 82: 'violent rain showers',
  85: 'snow showers', 86: 'heavy snow showers',
  95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'thunderstorm with heavy hail',
};
const wmo = (code) => WMO_CODES[code] ?? `weather code ${code}`;

async function geocode(place) {
  if (!place || !String(place).trim()) return MIAMI;
  const data = await fetchJson(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(String(place).trim())}&count=1&language=en&format=json`
  );
  const hit = data?.results?.[0];
  if (!hit) return null;
  return {
    name: [hit.name, hit.admin1, hit.country].filter(Boolean).join(', '),
    lat: hit.latitude,
    lng: hit.longitude,
  };
}

/**
 * get_weather(city_or_zip, date?) — Open-Meteo, no API key.
 * Returns current conditions plus the daily forecast for `date` (if given and
 * within the 16-day forecast window; otherwise today's forecast).
 */
export async function getWeather({ city_or_zip, date } = {}) {
  const loc = await geocode(city_or_zip);
  if (!loc) return { error: `could not find a location matching "${city_or_zip}"` };

  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lng}` +
    `&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max` +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=America%2FNew_York&forecast_days=16`;

  const data = await fetchJson(url);
  const c = data.current;
  const result = {
    location: loc.name,
    current: c
      ? {
          conditions: wmo(c.weather_code),
          temp_f: c.temperature_2m,
          feels_like_f: c.apparent_temperature,
          humidity_pct: c.relative_humidity_2m,
          wind_mph: c.wind_speed_10m,
        }
      : null,
    forecast: null,
  };

  const days = data.daily?.time ?? [];
  const want = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : days[0];
  const i = days.indexOf(want);
  const di = i >= 0 ? i : 0;
  if (days.length) {
    result.forecast = {
      date: days[di],
      requested_date_unavailable: i < 0 && want !== days[0] ? true : undefined,
      conditions: wmo(data.daily.weather_code[di]),
      high_f: data.daily.temperature_2m_max[di],
      low_f: data.daily.temperature_2m_min[di],
      rain_chance_pct: data.daily.precipitation_probability_max[di],
      max_wind_mph: data.daily.wind_speed_10m_max[di],
    };
  }
  return result;
}

// --- web_search --------------------------------------------------------------

function stripHtml(s) {
  return String(s ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * web_search(query) — DuckDuckGo instant-answer API first; if it has nothing,
 * fall back to scraping the lite HTML endpoint for top results.
 */
export async function webSearch({ query } = {}) {
  if (!query || !String(query).trim()) return { error: 'query is required' };
  const q = String(query).trim();

  // 1. Instant answer API
  try {
    const data = await fetchJson(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`
    );
    const results = [];
    if (data.AbstractText) {
      results.push({ title: data.Heading || q, snippet: stripHtml(data.AbstractText), url: data.AbstractURL || null });
    }
    for (const t of (data.RelatedTopics ?? []).slice(0, 5)) {
      const topic = t.Text ? t : t.Topics?.[0];
      if (topic?.Text) results.push({ title: null, snippet: stripHtml(topic.Text), url: topic.FirstURL ?? null });
      if (results.length >= 5) break;
    }
    if (results.length) return { query: q, results: results.slice(0, 5) };
  } catch {
    // fall through to the HTML scrape
  }

  // 2. Lite HTML scrape fallback (the lite endpoint wants a POST form submit)
  try {
    const res = await fetch('https://lite.duckduckgo.com/lite/', {
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': 'Mozilla/5.0 (compatible; gulf-breeze-front-desk/0.1)',
      },
      body: `q=${encodeURIComponent(q)}`,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from lite.duckduckgo.com`);
    const html = await res.text();
    // result rows: <a ... class='result-link' ...>title</a> then a
    // <td class='result-snippet'>...</td> (single-quoted attrs, href order varies)
    const links = [];
    for (const m of html.matchAll(/<a\b[^>]*class=["']result-link["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      const href = m[0].match(/href=["']([^"']+)["']/i)?.[1] ?? null;
      links.push({ url: href, title: stripHtml(m[1]) });
    }
    const snips = [...html.matchAll(/<td[^>]*class=["']result-snippet["'][^>]*>([\s\S]*?)<\/td>/gi)];
    const results = links.slice(0, 5).map((l, i) => ({
      title: l.title || null,
      snippet: stripHtml(snips[i]?.[1] ?? ''),
      url: l.url,
    }));
    if (results.length) return { query: q, results };
    return { query: q, results: [], note: 'no results found' };
  } catch (err) {
    return { error: `web search failed: ${err.message}` };
  }
}
