import React, { useEffect, useState } from "react"
import { Link, useCurrentRouteData } from "@tata1mg/router"
import css from "./Home.scss"

function Home() {
    const { isFetching, error, data } = useCurrentRouteData()
    const features = data?.features ?? []

    // Additional garnish fetched purely on the client, after hydration,
    // from the Express server's /api/tips endpoint.
    const [tips, setTips] = useState([])
    useEffect(() => {
        let active = true
        fetch("/api/tips")
            .then((res) => res.json())
            .then((json) => {
                if (active) setTips(json.tips ?? [])
            })
            .catch(() => {})
        return () => {
            active = false
        }
    }, [])

    return (
        <section className={css.card}>
            <h1 className={css.heading}>Home</h1>
            <p className={css.lead}>
                This list is fetched from the Express server&apos;s own <code>/api/features</code>{" "}
                endpoint, which parses <code>server/data/features.json</code>.
            </p>

            {isFetching && <p className={css.state}>Loading features…</p>}
            {error && <p className={css.error}>Failed to load features.</p>}

            {!isFetching && !error && (
                <ul className={css.list}>
                    {features.map((feature) => (
                        <li key={feature.id} className={css.item}>
                            <span className={css.itemTitle}>{feature.title}</span>
                            <span className={css.itemDesc}>{feature.description}</span>
                        </li>
                    ))}
                </ul>
            )}

            {data?.servedAt && (
                <p className={css.caption}>
                    served by {data.source} · {data.servedAt} · identity:{" "}
                    {data.whoami ?? "anonymous"}
                </p>
            )}

            {tips.length > 0 && (
                <div className={css.garnish}>
                    <span className={css.garnishLabel}>Client-side tips</span>
                    <ul className={css.garnishList}>
                        {tips.map((tip, index) => (
                            <li key={index}>{tip}</li>
                        ))}
                    </ul>
                </div>
            )}

            <Link className={css.cta} to="/about">
                Go to About →
            </Link>
        </section>
    )
}

// Approach C2 (shipped in the app): standard Catalyst data fetching — the server builds
// absolute URLs to its own API from the request; the client uses relative URLs. The
// Cloudflare adapter transparently reroutes the server-side same-origin fetch through the
// SELF binding (forwarding request context), so this component is identical on Node and
// Workers and never mentions the environment.
Home.serverFetcher = async ({ req }) => {
    const origin = `${req.protocol}://${req.get("host")}`
    const [features, whoami] = await Promise.all([
        fetch(`${origin}/api/features?limit=3`).then((r) => r.json()),
        fetch(`${origin}/api/whoami`).then((r) => (r.ok ? r.json() : { user: null })),
    ])
    return { ...features, whoami: whoami.user }
}

Home.clientFetcher = async () => {
    const [features, whoami] = await Promise.all([
        fetch("/api/features?limit=3").then((r) => r.json()),
        fetch("/api/whoami").then((r) => (r.ok ? r.json() : { user: null })),
    ])
    return { ...features, whoami: whoami.user }
}

Home.serverSideFunction = () => {
    return new Promise((resolve) => resolve())
}

export default Home
