import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildRequest, describeError, summarize } from '../format.js';

const SERVER = fileURLToPath(new URL('../server.js', import.meta.url));
const PARIS = { lon: 2.3522, lat: 48.8566 };
const VINCENNES = { lon: 2.4392, lat: 48.8474 };

const SAMPLE = {
  mode: 'bike',
  routes: [{
    variants: ['safe', 'balanced'], distanceM: 7159, durationS: 1525, ascentM: 38, descentM: 41,
    indicators: { cyclewayShare: 0.773, unpavedShare: 0, mainRoadShare: 0.036, motorwayShare: 0 },
    geometry: '_p~iF~ps|U_ulLnnqC',
    steps: [{ instruction: 'Head east', name: null, distanceM: 120, durationS: 28, type: 11 }],
  }],
  usage: { month: '2026-09', requests: 3, quota: 10000, plan: 'decouverte' },
  attribution: '© On va où ? · © openrouteservice by HeiGIT · © OpenStreetMap contributors',
};

test('request: longitude/latitude order, compact options', () => {
  const b = buildRequest({ origin: PARIS, destination: VINCENNES, mode: 'wheelchair', avoid: ['steep'], waypoints: [{ lon: 2.4, lat: 48.85 }] });
  assert.deepStrictEqual(b.origin, [2.3522, 48.8566]);
  assert.deepStrictEqual(b.waypoints, [[2.4, 48.85]]);
  assert.strictEqual(b.geometry, 'polyline');
  assert.strictEqual(b.elevation, false);
  assert.strictEqual(b.instructions, true);
  assert.deepStrictEqual(b.avoid, ['steep']);
  assert.strictEqual('variants' in b, false);
});

test('summary: distances, safety shares, steps, attribution; geometry only on request', () => {
  const { text, structured } = summarize(SAMPLE);
  assert.match(text, /Route 1 \(safe, balanced\): 7\.2 km, 25 min, \+38 m \/ -41 m\./);
  assert.match(text, /Cycle lanes 77 %, unpaved 0 %, main roads 4 %, motorways 0 %/);
  assert.match(text, /1\. Head east \(120 m\)/);
  assert.match(text, /Attribution/);
  assert.strictEqual(structured.routes[0].polyline, undefined);
  assert.strictEqual(summarize(SAMPLE, { includeGeometry: true }).structured.routes[0].polyline, SAMPLE.routes[0].geometry);
});

test('errors: readable, with a hint', () => {
  assert.match(describeError(422, { error: 'out_of_coverage', message: 'Point hors de la zone couverte' }), /422 out_of_coverage.*Europe only/);
  assert.match(describeError(401, { error: 'invalid_key', message: 'Clé invalide' }), /console\.onvaou\.app/);
});

async function withFakeApi(handler, fn) {
  const seen = [];
  const api = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.push({ url: req.url, key: req.headers['x-api-key'], body: JSON.parse(raw || '{}') });
      const [status, body] = handler(seen[seen.length - 1]);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  const client = new Client({ name: 'test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { ...process.env, OVO_API_URL: `http://127.0.0.1:${api.address().port}`, OVO_API_KEY: 'ovo_live_test' },
  });
  try {
    await client.connect(transport);
    await fn(client, seen);
  } finally {
    await client.close();
    api.close();
  }
}

test('MCP over stdio: one read-only tool, real call to the API, errors flagged', async () => {
  await withFakeApi((req) => (req.body.mode === 'foot' ? [422, { error: 'no_route', message: 'Aucun itinéraire trouvé' }] : [200, SAMPLE]), async (client, seen) => {
    const { tools } = await client.listTools();
    assert.deepStrictEqual(tools.map((t) => t.name), ['compute_route']);
    assert.strictEqual(tools[0].annotations.readOnlyHint, true);
    assert.deepStrictEqual(tools[0].inputSchema.required.sort(), ['destination', 'origin']);

    const ok = await client.callTool({ name: 'compute_route', arguments: { origin: PARIS, destination: VINCENNES } });
    assert.ok(!ok.isError);
    assert.match(ok.content[0].text, /7\.2 km/);
    assert.deepStrictEqual(seen[0], {
      url: '/v1/routes', key: 'ovo_live_test',
      body: { origin: [2.3522, 48.8566], destination: [2.4392, 48.8474], mode: 'bike', language: 'en', geometry: 'polyline', elevation: false, instructions: true },
    });

    const bad = await client.callTool({ name: 'compute_route', arguments: { origin: PARIS, destination: VINCENNES, mode: 'foot' } });
    assert.strictEqual(bad.isError, true);
    assert.match(bad.content[0].text, /422 no_route/);

    const invalid = await client.callTool({ name: 'compute_route', arguments: { origin: { lon: 500, lat: 0 }, destination: VINCENNES } }).catch((e) => ({ isError: true, content: [{ text: e.message }] }));
    assert.strictEqual(invalid.isError, true);
    assert.strictEqual(seen.length, 2, 'invalid arguments never reach the API');
  });
});
