# catalyst-cloudflare-plugin

Running a [Catalyst](https://github.com/tata1mg/catalyst-core) SSR app **natively on a
Cloudflare Worker** (via `httpServerHandler` + `nodejs_compat`) — not in a container.

This repo contains:

- **`adapter/`** — [`catalyst-cloudflare`](adapter/README.md), the reusable adapter (worker
  runtime, shims, prebuild, wrangler template) that makes a Catalyst app run on Workers.
- **`test-app/`** — a small two-route Catalyst example wired to the adapter, deployed live at
  `https://catalyst-test-app.varmasaurav95.workers.dev`. See its
  [`CLOUDFLARE-WORKERS.md`](test-app/CLOUDFLARE-WORKERS.md) for the full write-up: what changed,
  what works, caveats, the C2-vs-D data-fetching options with a 10-scenario test matrix, and the
  runtime-adapter-seam recommendations for Catalyst core.
- **[`GITHUB-DISCUSSION.md`](GITHUB-DISCUSSION.md)** — the community-facing framing (data-fetching
  isomorphism + runtime-adapter seam) intended for the upstream Catalyst discussion.

## Quick start (example app)

```bash
cd test-app
npm install
npm run dev:worker      # build + run on the Workers runtime locally (wrangler dev)
npm run deploy:worker   # build + wrangler deploy
```

## Status

Experimental / proof-of-concept. See the report's caveats. The highest-leverage follow-up is a
first-class Catalyst data-fetch primitive (`ctx.fetch` + in-process dispatch) that resolves the
server/client isomorphism on any runtime.
