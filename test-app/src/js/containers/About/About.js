import React, { useEffect, useState } from "react"
import { Link, useCurrentRouteData } from "@tata1mg/router"
import css from "./About.scss"

const MOCK_API_URL = "https://jsonplaceholder.typicode.com/users"
const GARNISH_API_URL = "https://jsonplaceholder.typicode.com/posts?_limit=3"

function About() {
    const { isFetching, error, data } = useCurrentRouteData()
    const users = Array.isArray(data) ? data : []

    // Additional garnish fetched purely on the client, after hydration,
    // from a free third-party endpoint.
    const [posts, setPosts] = useState([])
    useEffect(() => {
        let active = true
        fetch(GARNISH_API_URL)
            .then((res) => res.json())
            .then((json) => {
                if (active) setPosts(Array.isArray(json) ? json : [])
            })
            .catch(() => {})
        return () => {
            active = false
        }
    }, [])

    return (
        <section className={css.card}>
            <h1 className={css.heading}>About</h1>
            <p className={css.lead}>
                These users are fetched from a free mock API,{" "}
                <code>jsonplaceholder.typicode.com/users</code>, using the same route-level fetcher
                pattern.
            </p>

            {isFetching && <p className={css.state}>Loading users…</p>}
            {error && <p className={css.error}>Failed to load users.</p>}

            {!isFetching && !error && (
                <ul className={css.list}>
                    {users.slice(0, 5).map((user) => (
                        <li key={user.id} className={css.item}>
                            <span className={css.itemTitle}>{user.name}</span>
                            <span className={css.itemDesc}>
                                {user.email} · {user.company?.name}
                            </span>
                        </li>
                    ))}
                </ul>
            )}

            {posts.length > 0 && (
                <div className={css.garnish}>
                    <span className={css.garnishLabel}>Client-side posts</span>
                    <ul className={css.garnishList}>
                        {posts.map((post) => (
                            <li key={post.id}>{post.title}</li>
                        ))}
                    </ul>
                </div>
            )}

            <Link className={css.cta} to="/">
                ← Back to Home
            </Link>
        </section>
    )
}

const fetchUsers = async () => {
    const response = await fetch(MOCK_API_URL)
    return response.json()
}

// Both server (SSR) and client (navigation) fetch from the external mock API.
About.serverFetcher = fetchUsers
About.clientFetcher = fetchUsers

About.serverSideFunction = () => {
    return new Promise((resolve) => resolve())
}

export default About
