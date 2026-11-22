const { AsyncLocalStorage } = require('node:async_hooks');
const { performance } = require('node:perf_hooks');

const scope = new AsyncLocalStorage();
const paths = new Set(['/credits/subscription', '/credits/apple-subscription']);
// Only source-defined labels are accepted. Never derive one from a request,
// a model's data, a query/filter, a URL, a receipt, or an error message.
const operations = new Set([
    'account_lookup', 'storekit_scope', 'membership', 'allowance', 'attach_proofs', 'receipt_balance',
    'configuration_read', 'configuration_sync', 'revenuecat_request', 'verify_apple_signature',
    'db.wallet.findOne', 'db.subscription.findOne', 'db.recovery.findById',
    'db.deleted_account.findOne', 'db.recovery.replaceOne', 'db.recovery.insertOne',
    'db.subscription.find', 'db.ledger_account.findById', 'db.allocation.findById',
    'db.allocation.findOne', 'subscription_transaction', 'account_transaction',
    'subscription_initialization', 'account_initialization', 'renewal_promotion', 'usage_ledger',
]);

function timeSubscriptionOperation(operation, work) {
    const context = scope.getStore();
    if (!context || context.closed || !operations.has(operation)) return work();
    if (context.spans.length >= 128) { context.omitted++; return work(); }
    const span = { operation, started: performance.now(), durationMs: 0, outcome: 'pending' };
    context.spans.push(span);
    const finish = outcome => {
        span.durationMs = Math.round((performance.now() - span.started) * 100) / 100;
        span.outcome = outcome;
    };
    try {
        return Promise.resolve(work()).then(value => {
            finish('ok');
            return value;
        }, error => {
            finish('error');
            throw error;
        });
    } catch (error) {
        finish('error');
        throw error;
    }
}

function subscriptionTimingMiddleware({ logger = console } = {}) {
    return (req, res, next) => {
        // req.path is used only to select one of two fixed labels; never logged raw.
        const route = req.path.toLowerCase().replace(/\/+$/, '');
        if (req.method !== 'POST' || !paths.has(route)) return next();
        const context = { started: performance.now(), spans: [], omitted: 0, closed: false };
        const finish = completed => {
            if (context.closed) return;
            context.closed = true;
            const now = performance.now();
            const timing = {
                operation: route === '/credits/subscription' ? 'subscription_status' : 'subscription_proof_verification',
                durationMs: Math.round((now - context.started) * 100) / 100,
                outcome: completed ? 'completed' : 'aborted',
                httpStatus: res.statusCode,
                spans: context.spans.map(span => ({
                    operation: span.operation,
                    durationMs: span.outcome === 'pending' ? Math.round((now - span.started) * 100) / 100 : span.durationMs,
                    outcome: span.outcome === 'pending' ? 'unfinished' : span.outcome,
                })),
                omittedSpans: context.omitted,
            };
            // Logging must never affect billing, verification, or HTTP handling.
            try { logger.info('Subscription timing', timing); } catch {}
        };
        res.once('finish', () => finish(true));
        res.once('close', () => finish(false));
        return scope.run(context, next);
    };
}

module.exports = { subscriptionTimingMiddleware, timeSubscriptionOperation,
    subscriptionTimingActive: () => !!scope.getStore() };
