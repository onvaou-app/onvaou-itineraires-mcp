// Pure helpers of the MCP server: build the API request, turn the API
// response into a compact answer for an assistant. No I/O here (tested alone).

export const MODES = ['bike', 'ebike', 'scooter', 'moto', 'wheelchair', 'foot'];
export const VARIANTS = ['safe', 'balanced', 'fast'];
export const AVOIDABLE = ['ferries', 'steps', 'unpaved', 'steep', 'tolls', 'highways'];
export const LANGUAGES = ['en', 'fr', 'de', 'es', 'it', 'nl', 'pt'];

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

/** API error → one readable sentence for the assistant. */
export function describeError(status, body) {
  const code = body?.error ? ` ${body.error}` : '';
  const message = body?.message || body?.raw || 'no detail';
  const hints = {
    invalid_key: ' Check OVO_API_KEY (keys are created at https://console.onvaou.app).',
    rate_limited: ' Too many requests per second for the plan: retry in a second.',
    quota_exceeded: ' Monthly quota reached: upgrade at https://console.onvaou.app.',
    out_of_coverage: ' The API covers Europe only.',
    no_route: ' Move the points closer to a road or path usable by this vehicle.',
  };
  return `Routing API error ${status}${code}: ${message}.${hints[body?.error] || ''}`.replace(/\.\./g, '.');
}
