#!/usr/bin/env node
// MCP server (stdio) for the « On va où ? » Routing API.
//
// One tool, compute_route: bike, e-bike, kick scooter, motorcycle, wheelchair
// and walking routes across Europe, up to three variants (safe, balanced,
// fast) with safety indicators (cycle lanes, unpaved, main roads, motorways),
// climb and turn-by-turn steps.
//
// Configuration (environment):
//   OVO_API_KEY  required, free key at https://console.onvaou.app
//   OVO_API_URL  optional, API base URL (default below)

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { AVOIDABLE, LANGUAGES, MODES, VARIANTS, buildRequest, describeError, summarize } from './format.js';

const DEFAULT_API_URL = 'https://api.onvaou.app';
const API_URL = String(process.env.OVO_API_URL || DEFAULT_API_URL).replace(/\/$/, '');
const API_KEY = String(process.env.OVO_API_KEY || '').trim();

const point = z.object({
  lon: z.number().min(-180).max(180).describe('Longitude, WGS 84'),
  lat: z.number().min(-90).max(90).describe('Latitude, WGS 84'),
});

const server = new McpServer({ name: 'onvaou-itineraires', version: '0.1.1' });

server.registerTool('compute_route', {
  title: 'Compute a bike, scooter, motorcycle, wheelchair or walking route (Europe)',
  description: [
    'Computes up to three routes (safe, balanced, fast) between two points in Europe for a bike, e-bike,',
    'kick scooter, motorcycle, wheelchair or on foot, with the share of cycle lanes, unpaved surfaces,',
    'main roads and motorways, the climb, and turn-by-turn steps. Use it to plan a safe cycling commute,',
    'compare a safe and a fast option, check wheelchair accessibility of a trip, or plan a motorcycle trip',
    'avoiding tolls or motorways. Coordinates are longitude/latitude: geocode addresses first.',
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
  if (!API_KEY) {
    return {
      isError: true,
      content: [{ type: 'text', text: 'OVO_API_KEY is not set. Create a free key at https://console.onvaou.app and set it in the MCP server environment.' }],
    };
  }
  let res;
  try {
    res = await fetch(`${API_URL}/v1/routes`, {
      method: 'POST',
      headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json', 'User-Agent': 'onvaou-itineraires-mcp/0.1.1' },
      body: JSON.stringify(buildRequest(args)),
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `Routing API unreachable: ${err.message}` }] };
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { isError: true, content: [{ type: 'text', text: describeError(res.status, body) }] };
  const { text, structured } = summarize(body, { includeSteps: args.include_steps !== false, includeGeometry: !!args.include_geometry });
  return {
    content: [
      { type: 'text', text },
      { type: 'text', text: JSON.stringify(structured) },
    ],
  };
});

await server.connect(new StdioServerTransport());
