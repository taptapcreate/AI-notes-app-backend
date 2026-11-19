const { AsyncLocalStorage } = require('node:async_hooks');
const paths = new Set(['/notes', '/reply', '/followup', '/translate', '/polish', '/sentiment']);

// Reuse a single settings snapshot within one generation, never across requests.
// Maintenance/policy changes remain visible on the very next request.
function createRequestConfig(load) {
    const scope = new AsyncLocalStorage();
    return {
        getAppConfig() {
            const current = scope.getStore();
            if (!current) return load();
            current.pending ??= Promise.resolve().then(load);
            return current.pending;
        },
        middleware(req, _res, next) {
            const path = req.path.toLowerCase().replace(/\/+$/, '');
            if (req.method !== 'POST' || !paths.has(path)) return next();
            return scope.run({}, next);
        },
    };
}
module.exports = { createRequestConfig };
