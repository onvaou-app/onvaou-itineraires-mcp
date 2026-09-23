# « On va où ? » Routing API: MCP server

Address geocoding, and bike, e-bike, kick scooter, motorcycle, wheelchair and
walking routes across Europe, for AI assistants. One request turns a place name
into coordinates; the next returns up to three routes (safe, balanced, fast)
with what each one is worth: share of cycle lanes, unpaved surfaces, main roads
and motorways, climb, and turn-by-turn steps.

## Setup

1. Create a free API key at https://console.onvaou.app (10,000 requests per
   month, no credit card).
2. Add the server to your MCP client, for example Claude Desktop
   (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "onvaou-itineraires": {
      "command": "npx",
      "args": ["-y", "onvaou-itineraires-mcp"],
      "env": { "OVO_API_KEY": "ovo_live_..." }
    }
  }
}
```

Claude Code, same key, one line:

```bash
claude mcp add -e OVO_API_KEY=ovo_live_... onvaou-itineraires -- npx -y onvaou-itineraires-mcp
```

Both tools come with the server: ask for "a safe bike route from Gare de Rennes
to the Thabor park" and the assistant geocodes the two names, then routes
between the coordinates it got back.

## Tools

`geocode_address`: turns an address, a place name, a station or a point of
interest (`query`, 2 to 200 characters) into longitude/latitude candidates,
best first, each with a full label, its type and a confidence score. `type` is
one of `address` (a house number), `street`, `locality` (town, district),
`region`, `country`, `venue` (a named place: station, hotel, monument) or
`other`, and nothing else. Narrow the search with `near` (bias the ranking
around a point, which must itself be inside the European coverage), `country`
(ISO 3166-1 alpha-2), `limit` (1 to 5) and `language` (en, fr, de, it; en by
default, any other value refused). `it` is accepted, but the geocoder does not
label in Italian: the labels then come back in the local language of each
place (Milano, München). Results come from Photon (OpenStreetMap) across
Europe, and from the IGN Géoplateforme in France, which hands over to Photon
when it is unavailable, returns nothing, or its best confidence is below 0.4;
`source` says which one answered. Its coordinates go straight into
`compute_route`. Searches have their own daily allowance and never count
towards the monthly routing quota, so a lookup before a route is free.

`compute_route`: origin and destination (`{ "lon": 2.3522, "lat": 48.8566 }`),
up to 8 waypoints, `mode` (bike, ebike, scooter, moto, wheelchair, foot),
`variants`, `avoid` (ferries, steps, tolls, highways, unpaved, steep),
instruction `language` (en, fr, de, es, it, nl, pt), and whether to include
steps, the encoded polyline and the elevation profile. Give it coordinates:
when you only have a place name, call `geocode_address` first.

Both tools are read-only, answer with a short readable summary first, then the
same data as JSON, and report what the call cost: searches used today for the
geocoder, requests used this month for the router. Coverage: Europe. Each
answer carries its own `attribution` string, and the search also says which
`source` served it: display that attribution next to any route or result you
show.

Documentation: https://onvaou.app/developers/routing-api.html
Code examples: https://github.com/onvaou-app/routing-api-examples

## Development

```bash
npm install
npm test   # 11 tests, including a real MCP client over stdio against a mock API
```

License: MIT, © 2026 OVO SAS. Terms of the API: https://onvaou.app/cgv-api
