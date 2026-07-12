// The app has no body-consuming routes (all GET), so body parsing is unnecessary on the
// Worker. Stubbing body-parser drops its raw-body/iconv-lite dependency chain, which
// relies on Node stream internals that don't run cleanly on workerd.
const passthrough = () => (req, res, next) => next()
export const json = passthrough
export const raw = passthrough
export const text = passthrough
export const urlencoded = passthrough
export default { json, raw, text, urlencoded }
