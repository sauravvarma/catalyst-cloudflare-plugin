// Catalyst's SSR renderer uses react-dom/server's Node streaming API
// (renderToPipeableStream, piping to the Express response). On the Workers runtime that
// stream never completes and the request hangs. Synchronous rendering works fine, though
// (the renderer's own renderToString dry-run succeeds, and res.json responses complete),
// so we replace renderToPipeableStream with a renderToString-backed implementation that
// invokes the same callbacks and writes the HTML to the response in one shot.
//
// aliased for the bare `react-dom/server` specifier only; the import below uses
// `react-dom/server.browser`, so there's no self-recursion.
export * from "react-dom/server.browser"
import { renderToString } from "react-dom/server.browser"

export function renderToPipeableStream(node, options = {}) {
    let html = ""
    let error = null
    try {
        html = renderToString(node)
    } catch (e) {
        error = e
    }

    // React invokes these callbacks after returning the controller; mirror that ordering
    // (onShellReady -> caller pipes -> onAllReady -> caller writes trailer + ends).
    queueMicrotask(() => {
        if (error) {
            const onErr = options.onShellError || options.onError
            if (onErr) onErr(error)
            return
        }
        if (options.onShellReady) options.onShellReady()
        if (options.onAllReady) options.onAllReady()
    })

    return {
        // Write the shell but do NOT end — the renderer's onAllReady writes the CSS/JS
        // trailer and then calls res.end() itself.
        pipe(destination) {
            if (!error && destination) destination.write(html)
            return destination
        },
        abort() {},
    }
}
