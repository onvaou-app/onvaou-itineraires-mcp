import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildGeocodeRequest, buildRequest, describeError, summarize } from '../format.js';

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

const PHOTON_ATTRIBUTION = '© OpenStreetMap contributors (ODbL) · geocoding by Photon (komoot)';

// The public contract of POST /v1/geocode, field for field: query, source,
// twelve fields per result, attribution, and a usage block counted by the day
// and outside the monthly routing quota.
const SAMPLE_GEOCODE = {
  query: 'Gare de Rennes',
  source: 'photon',
  results: [
    {
      label: 'Gare de Rennes, 35000 Rennes, France', lon: -1.672515, lat: 48.103584, type: 'venue', confidence: 0.94,
      country: 'France', countryCode: 'FR', region: 'Bretagne', locality: 'Rennes', postalCode: '35000',
      street: 'Place de la Gare', houseNumber: null,
    },
    {
      label: '10 rue de Rivoli, 75004 Paris, France', lon: 2.359459, lat: 48.855122, type: 'address', confidence: 0.78,
      country: 'France', countryCode: 'FR', region: 'Île-de-France', locality: 'Paris', postalCode: '75004',
      street: 'Rue de Rivoli', houseNumber: '10',
    },
    {
      label: 'Rennes, Ille-et-Vilaine, France', lon: -1.6778, lat: 48.1113, type: 'locality', confidence: 0.61,
      country: 'France', countryCode: 'FR', region: 'Bretagne', locality: 'Rennes', postalCode: null,
      street: null, houseNumber: null,
    },
  ],
  attribution: PHOTON_ATTRIBUTION,
  usage: { dailyLimit: 500, usedToday: 12, countsTowardQuota: false },
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

test('geocode request: query trimmed, country upper-cased, language always sent', () => {
  // The API defaults to English; sending the field explicitly is what keeps
  // the tool and the endpoint on the same labels.
  assert.deepStrictEqual(buildGeocodeRequest({ query: '  Gare de Rennes  ' }), { query: 'Gare de Rennes', limit: 5, language: 'en' });
  assert.deepStrictEqual(
    buildGeocodeRequest({ query: 'Rivoli', limit: 2, country: 'fr', language: 'fr', near: { lon: 2.3522, lat: 48.8566 } }),
    { query: 'Rivoli', limit: 2, language: 'fr', near: { lon: 2.3522, lat: 48.8566 }, country: 'FR' },
  );
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

async function withFakeApi(handler, fn, { apiKey = 'ovo_live_test' } = {}) {
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
  // The key is set explicitly, never inherited: the "no key" case must hold
  // even on a machine where OVO_API_KEY is exported.
  const env = { ...process.env, OVO_API_URL: `http://127.0.0.1:${api.address().port}` };
  if (apiKey) env.OVO_API_KEY = apiKey; else delete env.OVO_API_KEY;
  const client = new Client({ name: 'test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env });
  try {
    await client.connect(transport);
    await fn(client, seen);
  } finally {
    await client.close();
    api.close();
  }
}

test('MCP over stdio: two read-only tools, real call to the API, errors flagged', async () => {
  await withFakeApi((req) => (req.body.mode === 'foot' ? [422, { error: 'no_route', message: 'Aucun itinéraire trouvé' }] : [200, SAMPLE]), async (client, seen) => {
    const { tools } = await client.listTools();
    assert.deepStrictEqual(tools.map((t) => t.name).sort(), ['compute_route', 'geocode_address']);
    assert.ok(tools.every((t) => t.annotations.readOnlyHint === true && t.annotations.openWorldHint === true));
    const route = tools.find((t) => t.name === 'compute_route');
    assert.deepStrictEqual(route.inputSchema.required.sort(), ['destination', 'origin']);
    // The routing description must send an agent to the geocoder, not leave it stuck.
    assert.match(route.description, /geocode_address/);

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

test('geocode_address: candidates listed then given as JSON, coordinates ready for compute_route', async () => {
  await withFakeApi(() => [200, SAMPLE_GEOCODE], async (client, seen) => {
    const { tools } = await client.listTools();
    const geocode = tools.find((t) => t.name === 'geocode_address');
    assert.deepStrictEqual(geocode.inputSchema.required, ['query']);

    const props = geocode.inputSchema.properties;
    // The API takes two characters at least: a one-letter query is refused
    // there, so the tool must not promise it.
    assert.strictEqual(props.query.minLength, 2);
    assert.strictEqual(props.query.maxLength, 200);
    // Labels come back in the four languages the endpoint takes, English by
    // default, exactly like compute_route. The endpoint refuses anything else,
    // so the enum is closed here too.
    assert.deepStrictEqual(props.language.enum, ['en', 'fr', 'de', 'it']);
    assert.strictEqual(props.language.default, 'en');
    // And it must say what `it` really does: the geocoder does not translate
    // into Italian, it answers with the local name of each place. Promising
    // Italian labels was a promise the API never kept.
    assert.match(props.language.description, /does not label in Italian/);
    assert.match(props.language.description, /local language/);
    // `near` biases the ranking, but a point outside Europe is refused.
    assert.match(props.near.description, /does not restrict the search/);
    assert.match(props.near.description, /422 out_of_coverage/);
    // The seven types the API really returns, and « poi », which it never
    // returns, nowhere in what the tool promises.
    for (const kind of ['address', 'street', 'locality', 'region', 'country', 'venue', 'other']) {
      assert.match(geocode.description, new RegExp(`\\b${kind}\\b`), kind);
    }
    assert.doesNotMatch(geocode.description, /\bpoi\b/);
    // And the rule that decides which source answers.
    assert.match(geocode.description, /hands over to Photon/);
    assert.match(geocode.description, /below 0\.4/);

    const ok = await client.callTool({
      name: 'geocode_address',
      arguments: { query: '  Gare de Rennes  ', near: PARIS, country: 'fr', limit: 3, language: 'fr' },
    });
    assert.ok(!ok.isError);
    assert.deepStrictEqual(seen[0], {
      url: '/v1/geocode', key: 'ovo_live_test',
      body: { query: 'Gare de Rennes', limit: 3, language: 'fr', near: { lon: 2.3522, lat: 48.8566 }, country: 'FR' },
    });

    const [readable, json] = ok.content;
    assert.match(readable.text, /3 candidates for "Gare de Rennes" \(source: Photon\), best first:/);
    assert.match(readable.text, /1\. Gare de Rennes, 35000 Rennes, France \(venue, confidence 94 %\): lon -1\.672515, lat 48\.103584/);
    assert.match(readable.text, /2\. 10 rue de Rivoli, 75004 Paris, France \(address, confidence 78 %\)/);
    assert.match(readable.text, /3\. Rennes, Ille-et-Vilaine, France \(locality, confidence 61 %\)/);
    assert.match(readable.text, /Pass the lon\/lat of the chosen candidate to compute_route/);
    assert.match(readable.text, new RegExp(`Attribution [^\n]*${PHOTON_ATTRIBUTION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    // The daily allowance, and the fact that a search is free of the quota.
    assert.match(readable.text, /Geocoding usage: 12 of 500 searches today, it does not count towards the monthly routing quota\./);
    assert.doesNotMatch(readable.text, /this month/);

    // Field for field with the API response: the twelve fields of a result,
    // plus query, source, attribution and usage. No field invented, none lost.
    const structured = JSON.parse(json.text);
    assert.deepStrictEqual(structured, {
      query: SAMPLE_GEOCODE.query,
      source: SAMPLE_GEOCODE.source,
      results: SAMPLE_GEOCODE.results,
      attribution: SAMPLE_GEOCODE.attribution,
      usage: SAMPLE_GEOCODE.usage,
    });
    assert.deepStrictEqual(Object.keys(structured.results[0]), [
      'label', 'lon', 'lat', 'type', 'confidence', 'country', 'countryCode',
      'region', 'locality', 'postalCode', 'street', 'houseNumber',
    ]);

    // A place name with the defaults: five candidates, labels in English.
    await client.callTool({ name: 'geocode_address', arguments: { query: 'Rennes' } });
    assert.deepStrictEqual(seen[1].body, { query: 'Rennes', limit: 5, language: 'en' });
  });
});

test('geocode_address: a one-character query and an unsupported label language never reach the API', async () => {
  await withFakeApi(() => [200, SAMPLE_GEOCODE], async (client, seen) => {
    const fail = (e) => ({ isError: true, content: [{ text: e.message }] });

    const tooShort = await client.callTool({ name: 'geocode_address', arguments: { query: 'R' } }).catch(fail);
    assert.strictEqual(tooShort.isError, true);
    assert.strictEqual(seen.length, 0, 'the API asks for two characters at least');

    // Two characters are legitimate: "Ax", "Oz" and a few dozen European
    // villages are named that way.
    const shortest = await client.callTool({ name: 'geocode_address', arguments: { query: 'Ax' } });
    assert.ok(!shortest.isError);
    assert.strictEqual(seen.length, 1);

    const wrongLanguage = await client.callTool({ name: 'geocode_address', arguments: { query: 'Rennes', language: 'es' } }).catch(fail);
    assert.strictEqual(wrongLanguage.isError, true);
    assert.strictEqual(seen.length, 1, 'the geocoder labels places in en, fr, de and it only');
  });
});

test('geocode_address: the French provider is reported as such', async () => {
  const FRENCH = {
    query: '10 rue de Rivoli, Paris',
    source: 'geoplateforme',
    results: [SAMPLE_GEOCODE.results[1]],
    attribution: '© IGN Géoplateforme, Base Adresse Nationale (Licence Ouverte 2.0)',
    usage: { dailyLimit: 500, usedToday: 1, countsTowardQuota: false },
  };
  await withFakeApi(() => [200, FRENCH], async (client) => {
    const ok = await client.callTool({ name: 'geocode_address', arguments: { query: '10 rue de Rivoli, Paris', country: 'FR' } });
    assert.match(ok.content[0].text, /1 candidate for "10 rue de Rivoli, Paris" \(source: Géoplateforme \(IGN\)\), best first:/);
    assert.match(ok.content[0].text, /Base Adresse Nationale \(Licence Ouverte 2\.0\)/);
    const structured = JSON.parse(ok.content[1].text);
    assert.strictEqual(structured.source, 'geoplateforme');
    assert.strictEqual(structured.results[0].houseNumber, '10');
  });
});

test('geocode_address: no result is not an error, it says what to try', async () => {
  const EMPTY = {
    query: 'zzzz nowhere at all',
    source: 'photon',
    results: [],
    attribution: PHOTON_ATTRIBUTION,
    usage: { dailyLimit: 500, usedToday: 13, countsTowardQuota: false },
  };
  await withFakeApi(() => [200, EMPTY], async (client) => {
    const empty = await client.callTool({ name: 'geocode_address', arguments: { query: 'zzzz nowhere at all' } });
    assert.ok(!empty.isError, 'an empty result set is a legitimate answer');
    assert.match(empty.content[0].text, /No place found for "zzzz nowhere at all" \(source: Photon\)/);
    assert.match(empty.content[0].text, /add the city or the country/);
    // A fruitless search is still a search: it is spent, and it is still free
    // of the monthly quota.
    assert.match(empty.content[0].text, /Geocoding usage: 13 of 500 searches today/);
    const structured = JSON.parse(empty.content[1].text);
    assert.deepStrictEqual(structured.results, []);
    assert.deepStrictEqual(structured.usage, EMPTY.usage);
  });
});

test('geocode_address: API errors are flagged and readable', async () => {
  await withFakeApi(() => [422, { error: 'out_of_coverage', message: 'Point hors de la zone couverte' }], async (client, seen) => {
    const bad = await client.callTool({ name: 'geocode_address', arguments: { query: 'Sydney Opera House' } });
    assert.strictEqual(bad.isError, true);
    assert.match(bad.content[0].text, /Geocoding API error 422 out_of_coverage/);
    assert.match(bad.content[0].text, /Europe only/);
    assert.strictEqual(seen.length, 1);

    const empty = await client.callTool({ name: 'geocode_address', arguments: { query: '   ' } }).catch((e) => ({ isError: true, content: [{ text: e.message }] }));
    assert.strictEqual(empty.isError, true);
    assert.strictEqual(seen.length, 1, 'an empty query never reaches the API');
  });
});

test('geocode_address: without a key, nothing is sent to the API', async () => {
  await withFakeApi(() => [200, SAMPLE_GEOCODE], async (client, seen) => {
    const noKey = await client.callTool({ name: 'geocode_address', arguments: { query: 'Gare de Rennes' } });
    assert.strictEqual(noKey.isError, true);
    assert.match(noKey.content[0].text, /OVO_API_KEY is not set/);
    assert.match(noKey.content[0].text, /console\.onvaou\.app/);
    assert.strictEqual(seen.length, 0);
  }, { apiKey: null });
});
