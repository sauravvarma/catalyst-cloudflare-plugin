# catalyst-cloudflare

Run a [Catalyst](https://catalyst.1mg.com) SSR app **natively on a Cloudflare Worker** (via
`httpServerHandler` + `nodejs_compat`), not in a container. The adapter bundles the shims and
runtime wiring that make Catalyst's Node/Express server run on the Workers runtime.

## Install

```bash
npm i -D catalyst-cloudflare wrangler
```

## Wire it up

**1. Worker entry**: `worker/index.js` (import the runtime BEFORE the app):

```js
import { createWorker } from "catalyst-cloudflare/worker/runtime"
import fsAssets from "./fs-assets.generated.js" // produced by the prebuild
import app from "../build/expressServer.js"

export default createWorker(app, { fsAssets })
```

**2. Config**: `config/config.json`: set `"PUBLIC_STATIC_ASSET_URL": ""` (so SSR asset URLs
are same-origin `/assets/...`).

**3. wrangler.jsonc**: copy the blocks from `wrangler.partial.jsonc` (set your worker name in
`name` and the `SELF` service binding), and add your `assets` block:

```jsonc
{
  "name": "my-app",
  "main": "worker/index.js",
  "assets": { "directory": "./dist/public", "not_found_handling": "none",
              "run_worker_first": ["/", "/about", "/api/*"] }
  // + compatibility_date / flags / services / alias / define from wrangler.partial.jsonc
}
```

**4. Scripts**: `package.json`:

```jsonc
"build:worker":  "node node_modules/catalyst-cloudflare/prebuild.mjs",
"dev:worker":    "npm run build && npm run build:worker && wrangler dev",
"deploy:worker": "npm run build && npm run build:worker && wrangler deploy"
```

## Server-side data fetching (the isomorphism)

Catalyst runs one data operation per route in two transports: `serverFetcher` on direct
hit/SSR, `clientFetcher` on client navigation, both must hit the **same** handler. A Worker
can't fetch its own public hostname, so the adapter reroutes server-side same-origin fetches
through the `SELF` binding (in-process), forwarding the inbound request's cookies/auth.

- **C2 (default, zero app change):** write the standard pattern; the adapter's transparent
  `fetch` reroute handles it.
  ```js
  Page.serverFetcher = ({ req }) => fetch(`${req.protocol}://${req.get("host")}/api/x`).then(r => r.json())
  Page.clientFetcher = ()      => fetch("/api/x").then(r => r.json())
  ```
- **D (opt-in, identical call sites):** use the env-aware helper in both.
  ```js
  import { apiFetch } from "catalyst-cloudflare/worker/data-fetch"
  const load = () => apiFetch("/api/x").then(r => r.json())
  Page.serverFetcher = load
  Page.clientFetcher = load
  ```

See the test app's `CLOUDFLARE-WORKERS.md` for the full options analysis, trade-offs, and test
scenarios.

## What the adapter provides

| File | Role |
|---|---|
| `worker/runtime.js` | logger shim, C2 fetch reroute + context forwarding, D `__ctxFetch`, `createWorker(app)` |
| `worker/fs-shim.js` | serves `loadable-stats.json` + CSS the renderer reads via `fs` at request time |
| `worker/react-dom-server-shim.js` | replaces `renderToPipeableStream` (hangs on workerd) with synchronous rendering |
| `worker/{body-parser,middleware-factory,tty,empty}-stub.js` | stubs for Node-only/edge-unneeded deps |
| `worker/data-fetch.js` | optional `apiFetch` helper (Approach D) |
| `prebuild.mjs` | copies data, stages assets, generates the fs-assets map |
| `wrangler.partial.jsonc` | alias/define/services template |

## Known limitations

- SSR is **non-streaming** (synchronous render shim).
- No request-body parsing (`body-parser` stubbed); GET-oriented.
- fs-shim serves only bundled `loadable-stats.json` + CSS.
- OpenTelemetry disabled.
- Coupled to catalyst-core's compiled `build/` layout.
