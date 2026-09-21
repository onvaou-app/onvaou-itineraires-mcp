# « On va où ? » Routing API: MCP server

Bike, e-bike, kick scooter, motorcycle, wheelchair and walking routes across
Europe, for AI assistants. One request returns up to three routes (safe,
balanced, fast) with what each one is worth: share of cycle lanes, unpaved
surfaces, main roads and motorways, climb, and turn-by-turn steps.

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

## Tool

`compute_route`: origin and destination (`{ "lon": 2.3522, "lat": 48.8566 }`),
up to 8 waypoints, `mode` (bike, ebike, scooter, moto, wheelchair, foot),
`variants`, `avoid` (ferries, steps, tolls, highways, unpaved, steep),
instruction `language` (en, fr, de, es, it, nl, pt), and whether to include
steps, the encoded polyline and the elevation profile.

Coverage: Europe. Map data © OpenStreetMap contributors: display the returned
attribution next to any route you show.

Documentation: https://onvaou.app/developers/routing-api.html
Code examples: https://github.com/onvaou-app/routing-api-examples

## Development

```bash
npm install
npm test   # 4 tests, including a real MCP client over stdio against a mock API
```

License: MIT, © 2026 OVO SAS. Terms of the API: https://onvaou.app/cgv-api
