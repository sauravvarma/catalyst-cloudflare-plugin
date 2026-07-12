# Running Catalyst natively on Cloudflare Workers: what I learned, and a question about runtime seams

## TL;DR

I set out to let a Catalyst app **ship to Cloudflare Workers seamlessly**, running natively
on a Worker (not in a container). I got a two-route SSR app fully working on Workers
(SSR, `/api/*`, static assets, hydration, client-side navigation), live here:
`https://catalyst-test-app.varmasaurav95.workers.dev`.

Getting there surfaced two things worth discussing with the community:

1. A **data-fetching challenge** rooted in Catalyst's server/client isomorphism, where I ended
   up with **two candidate solutions** and would like input on which to standardize.
2. A broader observation: most of the adapter I wrote is working around **Node-runtime
   assumptions baked into core**. That points to a **runtime-adapter seam** in Catalyst, which
   would also **improve the plain Node (serverful) story**. I'd like to gauge appetite for
   exploring it.

This is written to start a conversation, not to land a specific PR yet.

**Links**
- Example repo (adapter + working app + full write-up): https://github.com/sauravvarma/catalyst-cloudflare-plugin
- Live demo: https://catalyst-test-app.varmasaurav95.workers.dev
- Full report covering changes, caveats, the C2-vs-D analysis, the 10-scenario test matrix, and runtime-seam recommendations: [`test-app/CLOUDFLARE-WORKERS.md`](https://github.com/sauravvarma/catalyst-cloudflare-plugin/blob/main/test-app/CLOUDFLARE-WORKERS.md)
- The `catalyst-cloudflare` adapter: [`adapter/`](https://github.com/sauravvarma/catalyst-cloudflare-plugin/tree/main/adapter)

---

## The goal

Take an existing Catalyst app and deploy it to Cloudflare Workers with as little friction as
possible, ideally `npm run deploy:worker`. Native Workers now supports Node HTTP servers via
`httpServerHandler` from `cloudflare:node` (with `nodejs_compat`), so Catalyst's production
Express app is a good fit in principle.

It works today via a small adapter (`catalyst-cloudflare`): a Worker entry that runs the built
Express app, plus shims for a handful of Node-isms that don't hold on the Workers runtime
(streaming SSR, per-request `fs` reads, a couple of Node-only deps, internal module aliases).
Details and the full test matrix are in the companion report; here I want to focus on the two
discussion-worthy parts.

---

## Challenge 1: data fetching and the server/client isomorphism

### The model (what makes Catalyst nice)

Catalyst defines **one data operation per route** that runs in two contexts:

- **Direct URL hit** runs it on the server during SSR (`serverFetcher`).
- **Client-side navigation into the route** runs it in the browser (`clientFetcher`).

A very common and desirable shape is for both to hit the **app's own API** (`/api/x`) so server
and client share one endpoint, whether that endpoint is a function, a DB query, or a proxy to a
third-party API.

### The Workers constraint

**A Worker cannot fetch its own public hostname.** On a normal Node server,
`fetch("http://localhost:PORT/api/x")` loops back cheaply; on Workers, a subrequest to
`https://<worker>.workers.dev/...` doesn't dispatch back into the same isolate. (Outbound fetches
to *other* origins are fine; third-party endpoints work as-is.)

So the standard `serverFetcher` that self-fetches its own API returns a 404 on Workers.

### What doesn't work / doesn't generalize

- **Absolute self-fetch over HTTP** fails on Workers.
- **Reading the resource directly on the server** (e.g. `import data from …`) only works when the
  endpoint is a static file. The moment it's a function/DB/proxy, the server runs *different code*
  than the client and the isomorphism breaks.

### The two solutions I prototyped

Both dispatch the server-side call to the app's **own route in-process** via a Worker
**self service binding** (`env.SELF`), forwarding the inbound request's cookies/auth. They differ
only in **developer experience**.

**C2: transparent adapter reroute (zero app change).** App code stays standard Catalyst; the
adapter patches `fetch` to route same-origin server calls internally.
```js
Page.serverFetcher = ({ req }) => fetch(`${req.protocol}://${req.get("host")}/api/x`).then(r => r.json())
Page.clientFetcher = ()      => fetch("/api/x").then(r => r.json())
```

**D: an environment-aware fetch, identical in both fetchers.**
```js
import { apiFetch } from "catalyst-cloudflare/worker/data-fetch"
const load = () => apiFetch("/api/x").then(r => r.json())
Page.serverFetcher = load
Page.clientFetcher = load
```

### How they compare

| | Node⇄Workers code parity | server⇄client call site identical | same handler runs | auto-forwards req context | app change | mechanism |
|---|---|---|---|---|---|---|
| **C2** | ✅ | ✗ (abs vs rel) | ✅ | ✅ | none | patches global `fetch` |
| **D** | ✅ | ✅ | ✅ | ✅ | adopt `apiFetch` | explicit helper / injected fetch |

I ran a 10-scenario matrix on both (identical behavior). Highlights:

- **Computed handler** (a `servedAt` timestamp) proves it's the real handler running, not a static read.
- **Cookie forwarding**: a self-call to `/api/whoami` sees the inbound `uid` cookie.
- **Third-party endpoint hit directly** from `serverFetcher` works, and is correctly *not* rerouted.
- **Concurrency** (12 parallel requests, distinct cookies): no context bleed (request-scoped via `AsyncLocalStorage`).
- **Cross-env parity**: the *same* app code runs on the Node prod server unchanged, but with a catch (below).

### The catch that reframes the whole thing

On the Node prod server, the standard self-fetch **silently drops the inbound cookie** (the app
never copied it), so `/api/whoami` sees no identity. On Workers, my adapter *forwards* it. So
"context-forwarding on a self-call" is **already a latent footgun on Node today**, not a
Workers-only concern.

And the deeper issue: a `serverFetcher` has **no first-class access to request-scoped context or
bindings**, so today the transport has to be smuggled in (I bridged via a global). I think the
framework should:

1. provide a **first-class in-process dispatch** for "call my own route" (no network loopback,
   in every runtime), and
2. **inject a request-bound, context-forwarding `fetch`** into `serverFetcher`/`clientFetcher`.

With those, the C2-vs-D debate mostly dissolves: core injects `ctx.fetch`, each runtime
implements it, and the app writes one line that works everywhere.

**I prefer D** (identical call sites; the cleanest expression of the isomorphism) and am shipping
**C2** in the demo app for now (zero migration). **Which would you standardize on?**

---

## Challenge 2: a runtime-adapter seam (and why serverful benefits too)

Stepping back: almost every shim I wrote patches a place where Catalyst core reaches directly
for a **Node/Express/`fs`/`winston`/`process.env`/`module-alias`** primitive or the **Node
react-dom streaming API**. That's the real finding: there's no seam between "framework logic"
and "runtime specifics."

The proposal is to make core runtime-agnostic and delegate environment concerns to a small
**Runtime Adapter interface**, with **Node as the default adapter**. Workers/Deno/Bun then become
adapters, not forks.

Candidate extension points:

- **`renderToStream`**: Node uses pipeable, edge uses `renderToReadableStream`. Core stops importing `react-dom/server` directly.
- **`assetManifest` / `serveStatic`**: the adapter supplies the loadable-stats + CSS manifest from memory/import, so core never does per-request `fs`.
- **`createServer` + middleware**: the adapter owns the transport; middleware is app-supplied, not baked.
- **`dispatchSelf` + `ctx.fetch`**: the isomorphism primitive from Challenge 1.
- **`logger`, `config`, `telemetry`**: injected, not global, with sensible edge/container defaults.

### Why this is worth it even if you never touch Workers

Framing this as "Workers-only" undersells it. Each item is also a **serverful improvement**:

1. **Kill per-request `fs`** for build manifests, lowering p99 (blocking I/O out of the render hot path).
2. **`ctx.fetch` that forwards request context** fixes the silent cookie/authz drop on self-calls that exists on Node today.
3. **In-process self-dispatch** avoids a loopback socket and a double middleware pass for server-side data fetching.
4. **stdout logger by default** is correct for containers/12-factor, with file transport opt-in.
5. **Build-time alias resolution** (instead of the `module-alias` runtime require-patch) is smaller/faster, works with any bundler, and is ESM-safe.
6. **Optional/lazy telemetry** (no unconditional `@opentelemetry/*` requires) means smaller bundles and faster cold start.
7. **Reproducible builds** (no absolute build-host paths baked in) enable Docker caching and relocatable artifacts.

Once middleware is pluggable and telemetry is optional, several of my shims (tty/otel/body-parser/compression stubs) **stop being necessary at all**; they only exist because those deps are currently unconditional.

### The question for the community

- Is a **runtime-adapter seam** something Catalyst wants to pursue, or is Node-Express-first an
  intentional constraint?
- If yes, does the **serverful-wins framing** resonate? Would you adopt these changes for the
  Node story alone?
- For data fetching specifically: **C2 or D**? And is injecting `ctx.fetch` (with in-process
  dispatch + context forwarding) something you'd take into core?

I'm happy to break this into concrete issues/PRs per extension point, starting with the
data-fetch primitive (the highest-leverage one). But I wanted to align on direction first.

---

*Appendix:* the working demo, the `catalyst-cloudflare` adapter, and the full options analysis
plus the 10-scenario test matrix are in the example repo linked at the top
(https://github.com/sauravvarma/catalyst-cloudflare-plugin).
