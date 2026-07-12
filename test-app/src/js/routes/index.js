import Home from "@containers/Home/Home"
import About from "@containers/About/About"

const routes = [
    {
        path: "/",
        end: true,
        component: Home,
    },
    {
        path: "/about",
        end: true,
        component: About,
    },
]

export default routes
