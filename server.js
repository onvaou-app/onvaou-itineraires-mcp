#!/usr/bin/env node
// MCP server (stdio) for the « On va où ? » Routing API.
//
// Two tools:
//   geocode_address, an address or place name → longitude/latitude candidates;
//   compute_route, bike, e-bike, kick scooter, motorcycle, wheelchair and
//   walking routes across Europe, up to three variants (safe, balanced, fast)
//   with safety indicators (cycle lanes, unpaved, main roads, motorways),
//   climb and turn-by-turn steps.
//
// Configuration (environment):
//   OVO_API_KEY  required, free key at https://console.onvaou.app
//   OVO_API_URL  optional, API base URL (default below)

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  AVOIDABLE, GEOCODE_LANGUAGES, GEOCODE_MAX_QUERY, GEOCODE_MAX_RESULTS, GEOCODE_MIN_QUERY,
  LANGUAGES, MODES, VARIANTS,
  buildGeocodeRequest, buildRequest, describeError, summarize, summarizeGeocode,
} from './format.js';

const VERSION = '0.2.0';
const DEFAULT_API_URL = 'https://api.onvaou.app';
const API_URL = String(process.env.OVO_API_URL || DEFAULT_API_URL).replace(/\/$/, '');
const API_KEY = String(process.env.OVO_API_KEY || '').trim();

const point = z.object({
  lon: z.number().min(-180).max(180).describe('Longitude, WGS 84'),
  lat: z.number().min(-90).max(90).describe('Latitude, WGS 84'),
});

const failure = (text) => ({ isError: true, content: [{ type: 'text', text }] });

const MISSING_KEY = 'OVO_API_KEY is not set. Create a free key at https://console.onvaou.app and set it in the MCP server environment.';

/**
 * One POST on the API. Returns { payload } on success, { error } with a
 * ready-to-return tool result otherwise. `what` names the API in the messages.
 */
async function postJson(path, body, what) {
  if (!API_KEY) return { error: failure(MISSING_KEY) };
  let res;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: 'POST',
      headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json', 'User-Agent': `onvaou-itineraires-mcp/${VERSION}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    return { error: failure(`${what} API unreachable: ${err.message}`) };
  }
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) return { error: failure(describeError(res.status, payload, what)) };
  return { payload };
}

const server = new McpServer({ name: 'onvaou-itineraires', version: VERSION });

server.registerTool('compute_route', {
  title: 'Compute a bike, scooter, motorcycle, wheelchair or walking route (Europe)',
  description: [
    'Computes up to three routes (safe, balanced, fast) between two points in Europe for a bike, e-bike,',
    'kick scooter, motorcycle, wheelchair or on foot, with the share of cycle lanes, unpaved surfaces,',
    'main roads and motorways, the climb, and turn-by-turn steps. Use it to plan a safe cycling commute,',
    'compare a safe and a fast option, check wheelchair accessibility of a trip, or plan a motorcycle trip',
    'avoiding tolls or motorways. Points are given as longitude/latitude: when you only have an address,',
    'a place name or a station, call geocode_address first and pass the coordinates it returns.',
  ].join(' '),
  inputSchema: {
    origin: point.describe('Start point'),
    destination: point.describe('End point'),
    waypoints: z.array(point).max(8).optional().describe('Up to 8 intermediate stops, in order'),
    mode: z.enum(MODES).default('bike').describe('bike, ebike, scooter (kick scooter), moto (motorcycle), wheelchair, foot'),
    variants: z.array(z.enum(VARIANTS)).min(1).optional().describe('Which variants to return (default: all three)'),
    avoid: z.array(z.enum(AVOIDABLE)).optional().describe('ferries, steps; tolls and highways (moto); unpaved and steep (wheelchair)'),
    language: z.enum(LANGUAGES).default('en').describe('Language of the turn-by-turn instructions'),
    include_steps: z.boolean().default(true).describe('Include turn-by-turn instructions'),
    include_geometry: z.boolean().default(false).describe('Include the encoded polyline (Google algorithm, precision 5)'),
    include_elevation_profile: z.boolean().default(false).describe('Include the elevation profile (up to 100 points)'),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async (args) => {
  const { payload, error } = await postJson('/v1/routes', buildRequest(args), 'Routing');
  if (error) return error;
  const { text, structured } = summarize(payload, { includeSteps: args.include_steps !== false, includeGeometry: !!args.include_geometry });
  return {
    content: [
      { type: 'text', text },
      { type: 'text', text: JSON.stringify(structured) },
    ],
  };
});

server.registerTool('geocode_address', {
  title: 'Find the coordinates of an address or a place (Europe)',
  description: [
    'Turns an address, a place name, a station or a point of interest into longitude/latitude coordinates,',
    'which are exactly what compute_route expects as origin, destination or waypoint. Call this first',
    'whenever the user names a place instead of giving coordinates. Returns up to five candidates, best',
    'first, each with a full label, its coordinates, its type (address, street, locality, region, country,',
    'venue for a named place such as a station or a monument, or other) and a confidence score, so an',
    'ambiguous name can be disambiguated before routing. Narrow the search with `near` (bias the ranking',
    'around a point, typically the other end of the trip) or `country`. Results come from Photon',
    '(OpenStreetMap) across Europe, and from the IGN Géoplateforme in France, which hands over to Photon',
    'when it is unavailable, returns nothing, or its best confidence is below 0.4; the answer says which',
    'source served it. A search has its own daily allowance and never counts towards the monthly routing',
    'quota, so looking a place up before routing costs nothing. Coverage: Europe.',
  ].join(' '),
  inputSchema: {
    query: z.string().trim().min(GEOCODE_MIN_QUERY).max(GEOCODE_MAX_QUERY).describe(`Address, place name or point of interest, ${GEOCODE_MIN_QUERY} to ${GEOCODE_MAX_QUERY} characters, for example "10 rue de Rivoli, Paris" or "Gare de Rennes"`),
    near: point.optional().describe('Bias the ranking towards this point, typically the other end of the trip. It does not restrict the search, but the point itself must be inside the European coverage: anywhere else is refused with 422 out_of_coverage'),
    country: z.string().regex(/^[A-Za-z]{2}$/).optional().describe('Restrict to one country, ISO 3166-1 alpha-2 code, for example FR or BE'),
    limit: z.number().int().min(1).max(GEOCODE_MAX_RESULTS).default(GEOCODE_MAX_RESULTS).describe(`Number of candidates to return, 1 to ${GEOCODE_MAX_RESULTS}`),
    language: z.enum(GEOCODE_LANGUAGES).default('en').describe('Language of the returned labels. en, fr and de are honoured; it is accepted but the geocoder does not label in Italian, and the labels then come back in the local language of each place (Milano, München). The French source answers in French only'),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async (args) => {
  const request = buildGeocodeRequest(args);
  const { payload, error } = await postJson('/v1/geocode', request, 'Geocoding');
  if (error) return error;
  const { text, structured } = summarizeGeocode(payload, { query: request.query });
  return {
    content: [
      { type: 'text', text },
      { type: 'text', text: JSON.stringify(structured) },
    ],
  };
});

await server.connect(new StdioServerTransport());
