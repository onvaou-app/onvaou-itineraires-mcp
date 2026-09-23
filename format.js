// Pure helpers of the MCP server: build the API request, turn the API
// response into a compact answer for an assistant. No I/O here (tested alone).

export const MODES = ['bike', 'ebike', 'scooter', 'moto', 'wheelchair', 'foot'];
export const VARIANTS = ['safe', 'balanced', 'fast'];
export const AVOIDABLE = ['ferries', 'steps', 'unpaved', 'steep', 'tolls', 'highways'];
export const LANGUAGES = ['en', 'fr', 'de', 'es', 'it', 'nl', 'pt'];
// The geocoding endpoint takes four languages and no more: anything else is
// refused there with 400 bad_language, so the tool refuses it too, before the
// call. English by default, like the routing one. Keep it in step with
// POST /v1/geocode. Note that `it` is accepted but not translated: the
// geocoder then labels places in their local language.
export const GEOCODE_LANGUAGES = ['en', 'fr', 'de', 'it'];
export const GEOCODE_MIN_QUERY = 2;
export const GEOCODE_MAX_QUERY = 200;
export const GEOCODE_MAX_RESULTS = 5;

const toLonLat = (p) => [p.lon, p.lat];

/** Tool arguments → body of POST /v1/routes. */
export function buildRequest(args) {
  const body = {
    origin: toLonLat(args.origin),
    destination: toLonLat(args.destination),
    mode: args.mode || 'bike',
    language: args.language || 'en',
    // An assistant rarely needs the full line: the encoded polyline is the
    // compact form, and the elevation profile is only fetched on request.
    geometry: 'polyline',
    elevation: !!args.include_elevation_profile,
    instructions: args.include_steps !== false,
  };
  if (args.waypoints?.length) body.waypoints = args.waypoints.map(toLonLat);
  if (args.variants?.length) body.variants = args.variants;
  if (args.avoid?.length) body.avoid = args.avoid;
  return body;
}

/**
 * Tool arguments → body of POST /v1/geocode. `near` stays an object here: the
 * geocoding endpoint takes a bias point, not a leg of a route. The language is
 * always sent: the API defaults to English, and a silent default is what made
 * the tool and the endpoint disagree on the language of the labels.
 */
export function buildGeocodeRequest(args) {
  const body = {
    query: String(args.query ?? '').trim(),
    limit: args.limit || GEOCODE_MAX_RESULTS,
    language: args.language || 'en',
  };
  if (args.near) body.near = { lon: args.near.lon, lat: args.near.lat };
  if (args.country) body.country = String(args.country).toUpperCase();
  return body;
}

const pct = (share) => (share == null ? 'n/a' : `${Math.round(share * 100)} %`);

function duration(s) {
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`;
}

function distance(m) {
  return m < 1000 ? `${m} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}

/**
 * API response → { text, structured }. The text is what the assistant reads;
 * `structured` keeps the numbers (and the geometry only when asked for).
 */
export function summarize(response, { includeSteps = true, includeGeometry = false, maxSteps = 20 } = {}) {
  const routes = Array.isArray(response?.routes) ? response.routes : [];
  const lines = [];
  routes.forEach((r, i) => {
    const ind = r.indicators || {};
    const climb = r.ascentM != null ? `, +${r.ascentM} m / -${r.descentM} m` : '';
    lines.push(`Route ${i + 1} (${(r.variants || []).join(', ')}): ${distance(r.distanceM)}, ${duration(r.durationS)}${climb}.`);
    lines.push(`  Cycle lanes ${pct(ind.cyclewayShare)}, unpaved ${pct(ind.unpavedShare)}, main roads ${pct(ind.mainRoadShare)}, motorways ${pct(ind.motorwayShare)}.`);
    if (includeSteps && Array.isArray(r.steps)) {
      const steps = r.steps.slice(0, maxSteps);
      steps.forEach((s, k) => lines.push(`  ${k + 1}. ${s.instruction} (${distance(s.distanceM)})`));
      if (r.steps.length > steps.length) lines.push(`  … ${r.steps.length - steps.length} more steps.`);
    }
  });
  if (!routes.length) lines.push('No route returned.');
  if (response?.attribution) lines.push(`Attribution (display it next to any route you show): ${response.attribution}`);
  if (response?.usage) lines.push(`Usage this month: ${response.usage.requests} / ${response.usage.quota} requests (plan ${response.usage.plan}).`);

  const structured = {
    mode: response?.mode,
    routes: routes.map((r) => ({
      variants: r.variants,
      distanceM: r.distanceM,
      durationS: r.durationS,
      ascentM: r.ascentM,
      descentM: r.descentM,
      indicators: r.indicators,
      ...(includeGeometry ? { polyline: r.geometry } : {}),
      ...(r.elevationProfile ? { elevationProfile: r.elevationProfile } : {}),
    })),
    attribution: response?.attribution,
  };
  return { text: lines.join('\n'), structured };
}

// Six decimals are ~10 cm: enough for an address, and short to read.
const coord = (n) => (Number.isFinite(n) ? String(Number(n.toFixed(6))) : 'n/a');
const score = (c) => (Number.isFinite(c) ? `, confidence ${Math.round(c * 100)} %` : '');

// The two geocoders the API picks from, written the way a reader expects.
const SOURCE_NAMES = { photon: 'Photon', geoplateforme: 'Géoplateforme (IGN)' };
const sourceName = (s) => (s ? SOURCE_NAMES[s] || s : null);

/**
 * The searches spent today. Geocoding has its own daily allowance and never
 * eats into the monthly routing quota: say both, an assistant that has to
 * budget its calls needs to know it can look a place up freely.
 */
function geocodeUsage(usage) {
  if (!usage || !Number.isFinite(Number(usage.usedToday))) return null;
  const limit = Number.isFinite(Number(usage.dailyLimit)) ? ` of ${usage.dailyLimit}` : '';
  const quota = usage.countsTowardQuota
    ? 'it counts towards the monthly routing quota'
    : 'it does not count towards the monthly routing quota';
  return `Geocoding usage: ${usage.usedToday}${limit} searches today, ${quota}.`;
}

/**
 * Geocoding response → { text, structured }. The text lists the candidates,
 * best first, with the coordinates to hand over to compute_route; `structured`
 * mirrors the API response field for field.
 */
export function summarizeGeocode(response, { query } = {}) {
  const results = Array.isArray(response?.results) ? response.results : [];
  // The API echoes the query it actually searched: prefer it over ours.
  const asked = response?.query ?? query;
  const about = asked ? ` for "${asked}"` : '';
  const source = sourceName(response?.source);
  const from = source ? ` (source: ${source})` : '';
  const lines = [];
  if (!results.length) {
    lines.push(`No place found${about}${from}. Try a more complete address, add the city or the country, or set \`country\` to narrow the search.`);
  } else {
    lines.push(`${results.length} candidate${results.length > 1 ? 's' : ''}${about}${from}, best first:`);
    results.forEach((r, i) => {
      const place = [r.locality, r.region, r.country].filter(Boolean).join(', ');
      const label = r.label || place || 'unnamed place';
      lines.push(`  ${i + 1}. ${label} (${r.type || 'place'}${score(r.confidence)}): lon ${coord(r.lon)}, lat ${coord(r.lat)}`);
    });
    lines.push('Pass the lon/lat of the chosen candidate to compute_route, as origin, destination or waypoint.');
  }
  if (response?.attribution) lines.push(`Attribution (display it next to any result you show): ${response.attribution}`);
  const usage = geocodeUsage(response?.usage);
  if (usage) lines.push(usage);

  const structured = {
    query: asked,
    source: response?.source,
    results: results.map((r) => ({
      label: r.label,
      lon: r.lon,
      lat: r.lat,
      type: r.type,
      confidence: r.confidence,
      country: r.country,
      countryCode: r.countryCode,
      region: r.region,
      locality: r.locality,
      postalCode: r.postalCode,
      street: r.street,
      houseNumber: r.houseNumber,
    })),
    attribution: response?.attribution,
    usage: response?.usage,
  };
  return { text: lines.join('\n'), structured };
}

/** API error → one readable sentence for the assistant. */
export function describeError(status, body, what = 'Routing') {
  const code = body?.error ? ` ${body.error}` : '';
  const message = body?.message || body?.raw || 'no detail';
  const hints = {
    invalid_key: ' Check OVO_API_KEY (keys are created at https://console.onvaou.app).',
    rate_limited: ' Too many requests per second for the plan: retry in a second.',
    quota_exceeded: ' Monthly quota reached: upgrade at https://console.onvaou.app.',
    geocode_daily_limit: ' Daily geocoding allowance reached for this key: retry tomorrow, routing is unaffected.',
    out_of_coverage: ' The API covers Europe only.',
    no_route: ' Move the points closer to a road or path usable by this vehicle.',
  };
  return `${what} API error ${status}${code}: ${message}.${hints[body?.error] || ''}`.replace(/\.\./g, '.');
}
