const express = require("express")
const path = require("path")
import featuresData from "./data/features.json"
import tipsData from "./data/tips.json"

// Server middlewares are added here.

export function addMiddlewares(app) {
    app.use("/favicon.ico", express.static(path.join(__dirname, "../public/favicon.ico")))

    // S1 — computed handler: proves the real handler runs (a static read can't produce servedAt).
    // S5 — honors a ?limit query param, to test query passthrough across the self-dispatch.
    app.get("/api/features", (req, res) => {
        const limit = Number(req.query.limit) || featuresData.features.length
        res.json({
            features: featuresData.features.slice(0, limit),
            source: "express-handler",
            servedAt: new Date().toISOString(),
        })
    })

    app.get("/api/tips", (req, res) => {
        res.json(tipsData)
    })

    // S2/S4 — request-context dependent: reads the `uid` cookie; 401 without it. Tests
    // whether a server-side self-call carries the inbound request's cookies/headers.
    app.get("/api/whoami", (req, res) => {
        const uid = (req.cookies && req.cookies.uid) || null
        if (!uid) {
            res.status(401).json({ error: "no uid cookie", sawCookieHeader: !!req.headers.cookie })
            return
        }
        res.json({ user: uid, servedAt: new Date().toISOString() })
    })

    // S6 — proxy: the endpoint itself hits a third-party API (nested outbound fetch).
    app.get("/api/proxy", async (req, res) => {
        const r = await fetch("https://jsonplaceholder.typicode.com/users")
        const users = await r.json()
        res.json({ count: users.length, first: users[0] && users[0].name })
    })

    // S3 — method preservation on the self-dispatch (body parsing is separately gated by
    // the body-parser stub; see report). Echoes what the handler actually received.
    app.all("/api/echo", (req, res) => {
        res.json({ method: req.method, hasBody: req.body != null && Object.keys(req.body || {}).length > 0 })
    })
}
