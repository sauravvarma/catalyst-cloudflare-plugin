import React from "react"
import { NavLink, Outlet } from "@tata1mg/router"
import css from "./App.scss"

const App = () => {
    return (
        <div className={css.shell}>
            <nav className={css.nav}>
                <span className={css.brand}>⚡ Catalyst</span>
                <div className={css.links}>
                    <NavLink
                        to="/"
                        end
                        className={({ isActive }) =>
                            isActive ? `${css.link} ${css.linkActive}` : css.link
                        }
                    >
                        Home
                    </NavLink>
                    <NavLink
                        to="/about"
                        className={({ isActive }) =>
                            isActive ? `${css.link} ${css.linkActive}` : css.link
                        }
                    >
                        About
                    </NavLink>
                </div>
            </nav>
            <main className={css.main}>
                <Outlet />
            </main>
        </div>
    )
}

App.serverSideFunction = () => {
    return new Promise((resolve) => resolve())
}

export default App
