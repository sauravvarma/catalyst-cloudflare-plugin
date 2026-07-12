# Catalyst on Cloudflare Workers — Report

Running a Catalyst (Node/Express SSR) app **natively on a Cloudflare Worker** (not a
container) via `httpServerHandler` from `cloudflare:node`. Live:
`https://catalyst-test-app.varmasaurav95.workers.dev`.

This documents what I changed, what works, the caveats, and — most importantly — the
Catalyst internals that need rethinking for the Workers runtime, with trade-offs.

---

## 1. What I changed

### App-level (things any Catalyst app would hit)
| File | Change | Why |
|---|---|---|
| `config/config.json` | `PUBLIC_STATIC_ASSET_URL: ""` | So SSR asset URLs are same-origin `/assets/...` instead of `http://localhost:3005/...` baked into `loadable-stats.json`. |
| `server/server.js` | `/api/*` handlers `import` JSON instead of `fs.readFileSync`; `/api/features` now computes fields at request time (`source`, `servedAt`) | The fs version was already broken in Node prod (`catalyst build` doesn't copy `server/data/` into `build/`). The computed fields prove the real handler runs (not a static read) in both transports — see §4. |
| `src/js/containers/Home/Home.js` | `serverFetcher` dispatches to the app's own `/api/features` route **in-process** (`globalThis.__selfFetch`); `clientFetcher` hits it over HTTP | Preserves Catalyst's isomorphism — same handler, two transports — and works on Workers. See §4. |
| `worker/index.js` | Exposes `globalThis.__selfFetch` backed by the `SELF` service binding (`env.SELF.fetch`) | Lets server-side fetching call the app's own routes internally (no public self-fetch). |
| `wrangler.jsonc` | Added `services: [{ binding: "SELF", service: "catalyst-test-app" }]` | Self service binding for in-process dispatch. |

### Build & config
| File | Purpose |
|---|---|
| `wrangler.jsonc` | `main` = `worker/index.js`; `nodejs_compat`; compat date `2025-09-01`; `assets` (dir `dist/public`, `run_worker_first` for SSR/API routes); `alias` map; `define` for `__dirname`/`process.env.*`; `vars`. |
| `worker/prebuild.mjs` (`npm run build:worker`) | Copies `server/data`→`build/data`; stages `build/public`→`dist/public/assets` (+ SW/offline/favicon at root) for Workers Assets; generates `worker/fs-assets.generated.js`. |
| `package.json` | Scripts `build:worker` / `dev:worker` / `deploy:worker`; `wrangler` devDep. |
| `.gitignore` | `dist`, `.wrangler`, generated fs-assets. |

### Worker entry + shims (the compatibility layer — this is the real "plugin")
| File | Role | Reason it exists |
|---|---|---|
| `worker/index.js` | Entry: imports bootstrap, then the built Express app; `app.listen(3000)`; `export default httpServerHandler({ port: 3000 })`. | Native Node-server-on-Workers mechanism. |
| `worker/bootstrap.js` | Sets `globalThis.logger` (console shim). | Catalyst's renderer calls a global `logger` normally installed by a dev/prod bootstrap the Worker never runs. |
| `worker/react-dom-server-shim.js` | Replaces `renderToPipeableStream` with a `renderToString`-backed impl. | Node-stream SSR **hangs** on workerd (never completes the response). |
| `worker/fs-shim.js` + `fs-assets.generated.js` | Serves `loadable-stats.json` + first-fold CSS from a bundled map by basename. | Renderer does `fs.readFileSync` on absolute build-host paths at request time. |
| `worker/body-parser-stub.js` | No-op `json`/`raw`/`urlencoded`/`text`. | `body-parser`→`raw-body`→`iconv-lite` uses Node stream internals that fail on workerd; app has no body-consuming routes. |
| `worker/middleware-factory-stub.js` | No-op middleware for `compression` + `express-static-gzip`. | Edge compresses; Workers Assets serves statics. |
| `worker/tty-stub.js` | `isatty:()=>false`. | `debug` (via finalhandler) requires `node:tty`, absent on workerd. |
| `worker/empty-stub.js` | `{}` for 11 `@opentelemetry/*` specifiers. | Referenced-but-uninstalled; static bundlers choke on them. |

**wrangler `alias` also remaps** the 3 `@catalyst/*` runtime requires → `build/*` (replacing
the `module-alias` runtime hook), and `react-dom/server` / `fs` / middleware / tty / otel
to the shims above.

---

## 2. What works right now (verified live, in a real browser)

- **SSR** on `/` and `/about` — server-rendered data present in initial HTML.
- **`/api/features`, `/api/tips`** — 200 with correct JSON.
- **Static assets** (`/assets/*.js|.css`), `/favicon.ico`, `/catalyst-sw.js` — served by Workers Assets.
- **Hydration** — client bundle boots.
- **Client-side navigation both directions** (Home↔About) — SPA transitions (no full reload), and the destination route's **`clientFetcher`** runs on navigation.
- **Client-only effects** — the `useEffect` "garnish" fetches (same-origin `/api/tips`, external JSONPlaceholder) populate after mount.
- **External outbound fetch** from SSR — `/about`'s server-side JSONPlaceholder fetch works.
- **Isomorphic data fetching** — Home's `/api/features` (a computed handler) runs identically
  via in-process dispatch on direct-hit/SSR and via HTTP on client navigation; verified live by
  the handler-computed `servedAt` timestamp appearing in both paths (§4).

---

## 3. Caveats & limitations

1. **SSR is non-streaming.** I render with `renderToString`, so progressive/streaming SSR
   (early flush, Suspense streaming) is lost. Fine for small pages; matters for large/slow ones.
2. **No request-body parsing.** `body-parser` is stubbed. GET-only app is fine; any POST/PUT
   consuming `req.body` would silently get nothing.
3. **fs shim is allow-listed.** Only `loadable-stats.json` + `*.css` (by basename) are served
   from the bundle. Any other runtime `fs.readFileSync` in app/framework code would fail.
4. **OpenTelemetry is disabled** (stubbed to `{}`). No tracing/metrics on the Worker.
5. **Compression/static handled off-Worker** (edge + Assets). The Express `compression` and
   `express-static-gzip` paths are dead.
6. **Tight coupling to catalyst-core's compiled `build/` layout** (v0.2.0-beta.2). The alias
   list, the fs read targets, and the streaming shim all assume current internals; a version
   bump can break them.
7. **Server-side "call my own API" needs in-process dispatch — see §4.** Implemented here via
   a `SELF` service binding + a `globalThis.__selfFetch` bridge. It works and generalizes, but
   the bridge is app-level glue because Catalyst gives `serverFetcher` no access to runtime
   bindings — a framework gap, not an app one (see §5.2).

---

## 4. The data-fetching isomorphism (the core requirement, and how I satisfied it)

### The principle

Catalyst defines **one data operation per route**. The *transport* changes with context; the
*operation does not*:

- **Direct URL hit** → the server executes the operation as part of SSR (`serverFetcher`).
- **Client-side navigation into that route** → the browser executes the *same* operation as a
  client request (`clientFetcher`).

The operation can be anything — an inline function, a **DB query**, a **proxy to another API**,
or a call to the app's own `/api/*` route (to stay DRY with the client). The requirement is:
**both contexts must resolve to the same handler, differing only by transport.** Any fix that
makes the server run *different code* than the client (e.g. reading a file on the server while
the client hits an endpoint) violates the model — it only appears correct when the endpoint is
a static resource, and diverges the moment the handler computes, queries, or proxies.

### The Workers constraint

**A Worker cannot fetch its own public hostname.** A subrequest to
`https://<worker>.workers.dev/...` does not dispatch back into the same isolate. Outbound
fetches to *other* origins are fine (that's why `/about`'s external API works). So the naive
"server does `fetch('https://self/api/x')`" both violates nothing conceptually *and* simply
fails at runtime (this is why `/` first returned 404).

### What satisfies the principle (ranked by "same handler, both transports")

| Approach | Same handler both sides? | Works on Workers? | Notes / trade-offs |
|---|---|---|---|
| **In-process dispatch via `SELF` binding** (implemented) | ✅ | ✅ | `env.SELF.fetch()` dispatches internally into the same Worker → runs the real route handler. Zero public network. **Needs the runtime's `env`/bindings reachable from the fetcher.** |
| **In-process router dispatch** (no binding) | ✅ | ✅ | Hand a synthetic `Request` straight to the Express `app`/router in-isolate. Same result, no binding, but Catalyst must expose a dispatch helper and manage req/res lifecycle. |
| **Shared service layer** | ⚠️ same *logic*, not same *handler* | ✅ | Both `/api` route and `serverFetcher` call one function. Runtime-agnostic and clean, but it's a **convention**, and the server no longer goes through the route/middleware the client does. |
| Absolute self-fetch over HTTP | ✅ | ❌ | Node-only; fails on Workers. |
| Read the resource directly | ❌ | ✅ | Only static resources; diverges server vs client. (This was the earlier stopgap — now replaced.) |

### What I implemented

The mechanism underneath every viable option is the same: **dispatch server-side same-origin
requests to the Worker's own routes in-process via a `SELF` service binding, forwarding the
inbound request's context (cookies/auth)**. The adapter (`catalyst-cloudflare`, §8) exposes it
two ways:

- **C2 (shipped in this app):** a transparent `fetch` reroute installed by the runtime. App code
  is the *standard* Catalyst pattern (server builds an absolute self URL from `req`, client uses
  a relative URL) and needs no changes.
- **D (available, opt-in):** an env-aware `apiFetch(path)` helper called *identically* in
  `serverFetcher` and `clientFetcher`.

**Proof it runs the real handler (not a static read):** `/api/features` computes `source` and
`servedAt: new Date().toISOString()` per request; `/api/whoami` reads the `uid` cookie. Both
transports produce fresh, handler-computed values and forwarded identity (see the scenario
results in §7). This generalizes to a function / DB query / proxy — it's literally the same
route handler; only the transport differs.

A full options analysis, DX comparison, and the 10-scenario test matrix with results is in **§7**.
The remaining framework gap (Catalyst should give `serverFetcher` first-class access to
in-process dispatch + request bindings, instead of the adapter's `globalThis`/ALS bridge) is in
**§5.2** — this is what I'll raise upstream (issue + PR), offering both C2 and D for the
community to weigh in.

---

## 5. Catalyst internals to rethink for edge/Workers

Each item: **issue → my workaround → proposed change → trade-off.**

1. **SSR uses Node streaming (`renderToPipeableStream`).**
   - Workaround: shim to `renderToString`.
   - Proposal: runtime-detect and use `renderToReadableStream` (Web streams) on edge runtimes.
   - Trade-off: keeps streaming benefits on edge, but two code paths to maintain; Web-stream SSR has slightly different backpressure/error semantics.

2. **`serverFetcher` assumes a network loopback to its own API, and can't reach runtime bindings.** (See §4.)
   - Workaround: `SELF` service binding + `globalThis.__selfFetch` bridge (implemented, verified live) so the server dispatches to its own routes in-process.
   - Proposal: Catalyst should (a) offer a first-class in-process dispatch for "call my own route," and (b) thread request-scoped `env`/bindings into the `serverFetcher` context so apps don't hand-roll a global.
   - Trade-off: a real framework API surface to design/support; big payoff — preserves the isomorphism on edge, works for fn/DB/proxy handlers, and removes the wasteful HTTP loopback even on Node.

3. **Runtime `fs.readFileSync` for build artifacts** (`loadable-stats.json`, first-fold CSS), on **absolute build-host paths baked into the bundle**.
   - Workaround: `fs` shim serving a bundled basename map; paths matched by basename.
   - Proposal: import these as modules at build time (or read once at init into memory) and use relative/config paths, never absolute build-host paths.
   - Trade-off: `fs` is trivial on Node; module-embedding is a build-step change but makes the output bundler/edge-portable and removes machine-specific paths.

4. **Express + Node-centric middleware** (`body-parser`, `compression`, `express-static-gzip`, `cookie-parser`) hard-wired into the compiled server.
   - Workaround: stub the ones that pull incompatible Node internals or are unnecessary at the edge.
   - Proposal: make the middleware stack pluggable / provide an edge server profile that omits them (edge handles compression + static).
   - Trade-off: Express familiarity + ecosystem vs. a leaner, edge-safe core; a server abstraction is more work but decouples Catalyst from Express internals.

5. **`module-alias` runtime require hook** for `@catalyst/*` / `@containers` / etc.
   - Workaround: replicate the mapping in wrangler `alias` (bundlers ignore the runtime hook).
   - Proposal: resolve aliases to real paths at build time so the emitted output is bundler-neutral.
   - Trade-off: loses some dev-time indirection convenience; gains compatibility with any bundler (esbuild/wrangler/rollup) with no per-consumer alias list to maintain.

6. **`global.logger` set by a separate bootstrap script**, backed by winston + rotating **files**.
   - Workaround: console shim on `globalThis` before app init.
   - Proposal: inject the logger (or lazy-init with a console fallback) rather than relying on a global from a script the runtime may not execute; make file transport opt-in (unusable on edge).
   - Trade-off: minor plumbing; removes a hidden global dependency and an edge-incompatible default.

7. **`process.env` read at module-init time.**
   - Workaround: esbuild/wrangler `define` pins values at bundle time; `vars` at runtime.
   - Proposal: read env lazily / from an injected config object.
   - Trade-off: negligible; avoids init-order pitfalls across runtimes.

8. **Uninstalled `@opentelemetry/*` `require`s present in the bundle.**
   - Workaround: alias all 11 specifiers to an empty stub.
   - Proposal: make telemetry truly optional — lazy/guarded imports so bundlers can drop them without stubs.
   - Trade-off: none meaningful; cleaner bundles everywhere.

9. **`catalyst build` doesn't copy non-JS server assets** (e.g. `server/data/*.json`) into `build/`.
   - Workaround: prebuild copies `server/data`→`build/data`.
   - Proposal: copy declared server assets during build.
   - Trade-off: none; fixes a latent Node-prod bug too.

---

## 6. Suggested next steps

1. **Done in prototype:** in-process dispatch via `SELF` binding (§4) — unblocks
   DB/function/proxy `serverFetcher`s. **Framework follow-up:** promote the `globalThis`
   bridge to a first-class Catalyst API that exposes in-process route dispatch + request-scoped
   bindings to `serverFetcher`.
2. Add an **edge/Web-streams SSR path** so streaming isn't lost.
3. Move build-artifact reads from **runtime `fs`** to **build-time module imports**.
4. Land **build-time alias resolution** so the plugin needs no hand-maintained alias list.
5. Treat items 1–4 as the core of a real `catalyst-cloudflare` adapter; the rest of the shims
   (tty/otel/middleware stubs) become unnecessary once Catalyst offers an edge server profile.

---

## 7. Server-side data-fetch options — full analysis (for the upstream RFC/PR)

I will raise this upstream and let the community decide. I prefer **D** but am shipping
**C2** in the app today (zero app change). Below: each option's code shape, the two DX lenses,
and the empirical scenario results.

### The options (call sites side by side)

**A — Standard absolute self-fetch (no adapter help).** Fails on Workers (can't fetch own host).
```js
Page.serverFetcher = ({ req }) => fetch(`${req.protocol}://${req.get("host")}/api/x`).then(r => r.json())
Page.clientFetcher = ()      => fetch("/api/x").then(r => r.json())
```

**B — `globalThis.__selfFetch` bridge.** Works, but Workers-specific API leaks into the component.
```js
Page.serverFetcher = () => globalThis.__selfFetch("/api/x").then(r => r.json())
Page.clientFetcher = () => fetch("/api/x").then(r => r.json())
```

**C2 — transparent adapter reroute (SHIPPED).** App = standard pattern; the adapter patches
`fetch` to route same-origin server calls through `SELF` with context forwarding.
```js
Page.serverFetcher = ({ req }) => fetch(`${req.protocol}://${req.get("host")}/api/x`).then(r => r.json())
Page.clientFetcher = ()      => fetch("/api/x").then(r => r.json())
```

**D — env-aware fetch, identical in both (PREFERRED).**
```js
import { apiFetch } from "catalyst-cloudflare/worker/data-fetch"
const load = () => apiFetch("/api/x").then(r => r.json())
Page.serverFetcher = load
Page.clientFetcher = load
```

**E — shared service layer.** Server calls a function directly; client hits the endpoint.
```js
Page.serverFetcher = () => getX()                    // skips the HTTP route + its middleware
Page.clientFetcher = () => fetch("/api/x").then(r => r.json())
```

### Two DX lenses + architecture

| | Node⇄Workers code parity | server⇄client call site identical | same *handler* runs | auto-forwards req context | app change needed | mechanism smell |
|---|---|---|---|---|---|---|
| A | ✅ | ✗ (abs vs rel) | ✅ | ✗ | none | — (but broken on Workers) |
| B | ✗ (Workers-only) | ✗ | ✅ | manual | rewrite fetchers | global leaks into app |
| **C2** | ✅ | ✗ (abs vs rel) | ✅ | ✅ (ALS) | **none** | monkeypatches global `fetch` |
| **D** | ✅ | ✅ | ✅ | ✅ | adopt `apiFetch` | explicit; none |
| E | ✅ | ✗ | ⚠️ same logic, skips route/middleware | ✗ | refactor to service fns | quiet divergence |

### Scenario matrix (run on `wrangler dev`; C2 shown, D behaves identically)

| # | Scenario | Result |
|---|---|---|
| S1 | Computed handler (`servedAt`) runs via self-dispatch | ✅ fresh timestamp in SSR |
| S2 | Cookie forwarding (`uid=alice` → `identity`) | ✅ `alice` on Workers (see S9 caveat) |
| S3 | POST method preserved on dispatch | ✅ method; **body not forwarded** (body-parser stubbed + patch forwards headers only) |
| S4 | Non-200 propagation (401 no cookie) | ✅ |
| S5 | Query passthrough (`?limit=3`) | ✅ 3 items rendered |
| S6 | Proxy handler (endpoint → third-party) | ✅ `{count:10}` |
| S7 | Client-nav parity (`clientFetcher` over HTTP) | ✅ same handler, cookie via browser |
| S8 | Concurrency (12 parallel, distinct cookies) | ✅ no context bleed (ALS is request-scoped) |
| S9 | Cross-env parity (same code on Node `serve`) | ✅ happy path; ⚠️ **cookie NOT auto-forwarded on Node** (raw self-fetch drops it) — Workers C2 forwards, Node doesn't → context-semantics divergence |
| S10 | **Third-party endpoint hit directly** from `serverFetcher` (About → JSONPlaceholder) | ✅ works, correctly **not** rerouted |

### Sharpest differentiators

- **S9** shows C2's transparent forwarding makes Workers behave differently from vanilla Node
  (which drops the cookie). True parity needs either a matching Node adapter or *no* auto-forward
  (require the app to copy headers). **D** sidesteps this by owning forwarding in one helper across
  both runtimes.
- **S2/S3** show naive self-dispatch loses request context/body unless the adapter forwards it —
  the adapter, not the app, should own this.
- **S10** confirms external/third-party fetches must pass through untouched — both C2 and D do.

### Why C2 now, D later

- **C2 shipped**: zero migration — existing Catalyst apps' standard `serverFetcher` works
  unchanged on Workers. Cost: a global `fetch` monkeypatch and the residual server⇄client
  asymmetry.
- **D preferred**: identical call sites (best expression of the isomorphism, and what you
  prioritized), no monkeypatch, and it's the natural shape for a framework-injected
  `ctx.fetch`. Cost: apps adopt a helper (or Catalyst injects it).
- **E rejected** as a default: it silently skips the route's middleware, so auth/headers behave
  differently server vs client.

---

## 8. The packaged adapter (`catalyst-cloudflare`)

The shims and runtime wiring are extracted into a reusable package at `../adapter`
(consumed by this app via `file:` + `--install-links`). An app adopts Workers by: installing
the package, adding a thin `worker/index.js` (`createWorker(app, { fsAssets })`), copying the
`wrangler.partial.jsonc` blocks, setting `PUBLIC_STATIC_ASSET_URL: ""`, and adding the
`build:worker`/`deploy:worker` scripts. Contents:

| File | Role |
|---|---|
| `worker/runtime.js` | logger shim, C2 fetch reroute + ALS context forwarding, D `__ctxFetch`, `createWorker(app)` |
| `worker/fs-shim.js` | serves `loadable-stats.json` + CSS the renderer reads via `fs` |
| `worker/react-dom-server-shim.js` | sync-render replacement for `renderToPipeableStream` |
| `worker/{body-parser,middleware-factory,tty,empty}-stub.js` | Node-only / edge-unneeded dep stubs |
| `worker/data-fetch.js` | optional `apiFetch` (Approach D) |
| `prebuild.mjs` | copies `server/data`, stages `dist/public`, generates the fs-assets map |
| `wrangler.partial.jsonc` | alias / define / services template |

Note: the `file:` dependency must be installed with `npm install --install-links` so the
package is copied into `node_modules` (not symlinked) — otherwise the react-dom shim can't
resolve `react-dom` from the app.

---

## 9. Runtime-adapter seam — architecture recommendations (for the upstream discussion)

Stepping back from individual shims: **almost every shim I wrote patches a place where Catalyst
core reaches directly for a Node/Express/`fs`/`winston`/`process.env`/`module-alias` primitive or
the Node react-dom streaming API.** The root cause isn't "missing Workers support" — it's that
there's **no seam between framework logic and runtime specifics**.

Proposal: make core runtime-agnostic and delegate environment concerns to a small **Runtime
Adapter interface**, with **Node as the default adapter**. Workers/Deno/Bun then become adapters,
not forks — and most of my stubs cease to exist.

### Each shim → assumption it patches → framework change → does it also help serverful?

| Shim I wrote | Baked-in assumption | Framework change | Serverful win? |
|---|---|---|---|
| `react-dom-server-shim` | SSR hardwired to Node `renderToPipeableStream` + fragile pipe/`onAllReady` | abstract render strategy; add `renderToReadableStream` path | ✅ modern API; removes brittle double-write on Node |
| `fs-shim` | build manifests read from disk **per request** on absolute build-host paths | load manifest **once at init** (or import as module); relative paths | ✅ blocking `fs` out of hot path (p99); relocatable artifacts |
| `body-parser`/`compression`/`static-gzip` stubs | a fixed Express middleware stack is baked in | **pluggable middleware**; nothing the app didn't opt into | ✅ app-layer compression usually wrong; per-request parse overhead |
| `tty`/`empty` (otel) stubs | unconditional `require("@opentelemetry/*")` + `debug`→`tty` | **optional/lazy telemetry**; no hard requires of optional deps | ✅ smaller bundle, faster cold start |
| wrangler `alias` for `@catalyst/*` | internal aliases via `module-alias` **runtime require-patch** | resolve aliases **at build time** to real paths | ✅ ESM/bundler-safe, less startup cost |
| `globalThis.logger` shim | global logger from a side-effecting bootstrap; **winston file** default | **inject** logger; **stdout default**, files opt-in | ✅ 12-factor; removes order-dependent global |
| `define` for `process.env`/`__dirname` | config/paths read at **module-init** | lazy/**injected config**; relative paths | ✅ init-order + testability |
| `SELF` dispatch + `ctx.fetch` (C2/D) | `serverFetcher` assumes HTTP loopback; no request context/bindings | **in-process dispatch** + injected **context-forwarding `ctx.fetch`** | ✅ **big** — fixes Node's silent cookie drop (S9); no loopback |
| prebuild copying `server/data` | build omits non-JS server assets | copy declared server assets in `catalyst build` | ✅ fixes latent Node prod bug |

### Candidate adapter interface (core calls in; Node is the default impl)

- **`renderToStream(tree, opts)`** — Node → pipeable; edge → readable stream.
- **`assetManifest` / `serveStatic`** — adapter supplies loadable-stats + CSS from memory/import; core never touches `fs` per request.
- **`createServer(handler)` + app-supplied middleware** — adapter owns the transport (Node http/Express, `httpServerHandler`, Deno.serve…).
- **`dispatchSelf(request)` + `ctx.fetch`** — the isomorphism primitive (in-process on Node, `SELF` on Workers); injected into fetchers.
- **`logger`, `config`/`env`, `telemetry`** — injected, not global; edge/container-friendly defaults.

### Serverful wins (lead the RFC with these)

1. Kill per-request `fs` for manifests → lower p99.
2. `ctx.fetch` auto-forwards request context → fixes the silent cookie/authz drop on Node self-calls (S9).
3. In-process self-dispatch → no loopback socket / double middleware.
4. stdout logger by default → correct for containers.
5. Build-time alias resolution → smaller/faster, bundler-neutral.
6. Optional/lazy telemetry → smaller bundles, faster cold start.
7. Reproducible builds (no absolute baked paths) → Docker cache, relocatable.

### What legitimately stays in a (thin) adapter

`httpServerHandler` wiring, the `SELF` binding, Workers Assets staging, workerd-specific bits.
Once middleware is pluggable and telemetry optional, the **tty/otel/body-parser/compression stubs
disappear** — they exist only because those deps are currently unconditional.

**Highest-leverage first step:** the data-fetch primitive (`ctx.fetch` + in-process dispatch) —
it resolves the C2/D isomorphism question *and* fixes a real serverful bug. See
`../GITHUB-DISCUSSION.md` for the community-facing framing.
