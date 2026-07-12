// catalyst-cloudflare runtime — the reusable core of the adapter.
//
// Importing this module (which the Worker entry must do BEFORE importing the Catalyst app)
// has three side effects the app relies on:
//   1. installs a console `globalThis.logger` (Catalyst's renderer expects a global logger
//      that is normally set by a dev/prod bootstrap the Worker never runs);
//   2. installs the C2 same-origin fetch reroute (see below);
//   3. exposes the D-style context fetch (`globalThis.__ctxFetch`).
//
// createWorker(app) then wires the Express app to the Workers runtime via httpServerHandler,
// binding each inbound request into AsyncLocalStorage so server-side same-origin fetches can
// forward request context (cookies / authorization) to the in-process dispatch.
import { httpServerHandler } from "cloudflare:node"
import { env } from "cloudflare:workers"
import { AsyncLocalStorage } from "node:async_hooks"

// 1. logger shim
if (!globalThis.logger) {
    const line = (m) => (typeof m === "string" ? m : JSON.stringify(m))
    globalThis.logger = {
        info: (m) => console.log(line(m)),
        debug: () => {},
        warn: (m) => console.warn(line(m)),
        error: (m) => console.error(line(m)),
    }
}

const als = new AsyncLocalStorage()
const SELF_HOSTS = new Set()

// Return the path+query if `urlStr` targets this Worker's own origin (or is relative),
// else null. External URLs return null and are left untouched.
const selfPathOf = (urlStr) => {
    if (!urlStr) return null
    if (urlStr.startsWith("/")) {
        const u = new URL(urlStr, "https://self.local")
        return u.pathname + u.search
    }
    try {
        const u = new URL(urlStr)
        if (SELF_HOSTS.has(u.host)) return u.pathname + u.search
    } catch {
        /* not absolute */
    }
    return null
}

// Build headers for an internal dispatch, forwarding the inbound request's context.
const forwardedHeaders = (base) => {
    const headers = new Headers(base)
    const store = als.getStore()
    if (store && store.request) {
        for (const h of ["cookie", "authorization"]) {
            const v = store.request.headers.get(h)
            if (v && !headers.has(h)) headers.set(h, v)
        }
    }
    return headers
}

// Dispatch a request to this Worker's own routes, in-process, via the SELF service binding.
const dispatchSelf = (pathAndQuery, { method = "GET", headers } = {}) =>
    env.SELF.fetch(
        new Request(`https://catalyst-internal${pathAndQuery}`, {
            method,
            headers: forwardedHeaders(headers),
        }),
    )

// 2. C2 — transparent same-origin fetch reroute. App code calls fetch() normally.
const realFetch = globalThis.fetch.bind(globalThis)
globalThis.fetch = (input, init) => {
    const urlStr = typeof input === "string" ? input : input && input.url
    const selfPath = selfPathOf(urlStr)
    if (selfPath === null || !env.SELF) return realFetch(input, init)
    const method = (typeof input === "object" && input ? input.method : init && init.method) || "GET"
    const headers = (init && init.headers) || (typeof input === "object" && input ? input.headers : undefined)
    return dispatchSelf(selfPath, { method, headers })
}

// 3. D — explicit context fetch (used by an app helper that both fetchers call identically).
globalThis.__ctxFetch = (pathAndQuery) => dispatchSelf(pathAndQuery)

// Register the bundle-embedded file map the fs-shim serves (loadable-stats.json + CSS).
export const registerFsAssets = (map) => {
    globalThis.__CATALYST_FS_ASSETS__ = map || {}
}

// Wire the Catalyst Express app to the Workers runtime.
export function createWorker(app, options = {}) {
    const port = options.port || 3000
    if (options.fsAssets) registerFsAssets(options.fsAssets)
    app.listen(port)
    const base = httpServerHandler({ port })
    return {
        fetch(request, workerEnv, ctx) {
            try {
                SELF_HOSTS.add(new URL(request.url).host)
            } catch {
                /* ignore */
            }
            return als.run({ request }, () => base.fetch(request, workerEnv, ctx))
        },
    }
}
