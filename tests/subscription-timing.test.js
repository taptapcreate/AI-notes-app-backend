const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { subscriptionTimingMiddleware, timeSubscriptionOperation: time } = require('../services/subscription-timing');
function response(status = 200) {
    const res = new EventEmitter();
    res.statusCode = status;
    return res;
}
function fixture() {
    const logs = [];
    return { logs, middleware: subscriptionTimingMiddleware({ logger: { info: (label, value) => logs.push([label, value]) } }) };
}
test('timing logs cannot serialize request data, query results, or dynamic labels', async () => {
    const { middleware, logs } = fixture();
    const privateResult = { secret: 'PRIVATE-RESULT', toJSON() { throw new Error('Must not inspect results'); } };
    const req = { method: 'POST', path: '/credits/subscription/', body: { code: 'PRIVATE-CODE' }, headers: { authorization: 'PRIVATE-TOKEN' } };
    const res = response();
    await middleware(req, res, async () => {
        assert.equal(await time('account_lookup', () => time('db.wallet.findOne', async () => privateResult)), privateResult);
        assert.equal(await time('PRIVATE-DYNAMIC-LABEL', async () => privateResult), privateResult);
    });
    res.emit('finish');
    res.emit('close');
    assert.equal(logs.length, 1);
    assert.equal(logs[0][0], 'Subscription timing');
    const timing = logs[0][1];
    assert.deepEqual(Object.keys(timing).sort(), ['durationMs', 'httpStatus', 'omittedSpans', 'operation', 'outcome', 'spans']);
    assert.equal(timing.operation, 'subscription_status');
    assert.deepEqual(timing.spans.map(span => span.operation), ['account_lookup', 'db.wallet.findOne']);
    for (const span of timing.spans) {
        assert.deepEqual(Object.keys(span).sort(), ['durationMs', 'operation', 'outcome']);
        assert.ok(Number.isFinite(span.durationMs) && span.durationMs >= 0);
    }
    assert.doesNotMatch(JSON.stringify(logs), /PRIVATE|secret|headers|body|code|token|receipt|filter/i);
});
test('sync and async errors retain their identity while logs contain only outcomes', async () => {
    const { middleware, logs } = fixture();
    const res = response(503), error = new Error('PRIVATE-MONGO-ERROR');
    await middleware({ method: 'POST', path: '/credits/apple-subscription' }, res, async () => {
        assert.throws(() => time('verify_apple_signature', () => { throw error; }), candidate => candidate === error);
        await assert.rejects(time('membership', async () => { throw error; }), candidate => candidate === error);
    });
    res.emit('finish');
    assert.ok(logs[0][1].spans.every(span => span.outcome === 'error'));
    assert.doesNotMatch(JSON.stringify(logs), /PRIVATE|MONGO-ERROR/);
});
test('simultaneous requests have isolated timings and unrelated routes are not traced', async () => {
    const { middleware, logs } = fixture();
    const a = response(), b = response(), other = response();
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const first = middleware({ method: 'POST', path: '/credits/subscription' }, a,
        () => time('account_lookup', async () => { await held; await time('db.wallet.findOne', async () => null); }));
    await middleware({ method: 'POST', path: '/credits/apple-subscription' }, b,
        () => time('attach_proofs', async () => null));
    await middleware({ method: 'POST', path: '/notes' }, other,
        () => time('allowance', async () => null));
    b.emit('finish'); other.emit('finish');
    release(); await first; a.emit('finish');
    assert.equal(logs.length, 2);
    assert.deepEqual(logs[0][1].spans.map(span => span.operation), ['attach_proofs']);
    assert.deepEqual(logs[1][1].spans.map(span => span.operation), ['account_lookup', 'db.wallet.findOne']);
});
test('aborted requests log once, late work is safe, and logging failure cannot break requests', async () => {
    const { middleware, logs } = fixture();
    const res = response();
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const pending = middleware({ method: 'POST', path: '/credits/subscription' }, res,
        () => time('membership', () => held));
    res.emit('close'); res.emit('finish');
    release('PRIVATE'); assert.equal(await pending, 'PRIVATE');
    assert.equal(logs.length, 1);
    assert.equal(logs[0][1].outcome, 'aborted');
    assert.equal(logs[0][1].spans[0].outcome, 'unfinished');
    const throws = subscriptionTimingMiddleware({ logger: { info() { throw new Error('Log sink unavailable'); } } });
    const next = response();
    assert.equal(await throws({ method: 'POST', path: '/credits/subscription' }, next, async () => 42), 42);
    assert.doesNotThrow(() => next.emit('finish'));
});
test('the span count is bounded and operations still execute once outside a timing scope', async () => {
    const { middleware, logs } = fixture();
    const res = response();
    await middleware({ method: 'POST', path: '/credits/subscription' }, res, async () => {
        for (let i = 0; i < 140; i++) await time('account_lookup', async () => i);
    });
    res.emit('finish');
    assert.equal(logs[0][1].spans.length, 128);
    assert.equal(logs[0][1].omittedSpans, 12);
    let calls = 0;
    assert.equal(time('account_lookup', () => ++calls), 1);
    assert.equal(calls, 1);
});

test('real subscription routes retain their responses and sanitize unexpected-error logs', async () => {
    const express = require('express');
    const { createCreditRouter } = require('../routes/credits');
    const logs = [], errors = [];
    const logger = { info: (...args) => logs.push(args), error: (...args) => errors.push(args) };
    let fail = false;
    const app = express();
    app.use(express.json());
    app.use('/api', subscriptionTimingMiddleware({ logger }));
    app.use('/api/credits', createCreditRouter({ logger,
        credits: { byCode: async () => {
            if (fail) throw new Error('PRIVATE-CODE PRIVATE-DATABASE-ERROR');
            return time('db.wallet.findOne', async () => ({ _id: 'PRIVATE-IDENTIFIER' }));
        } },
        purchases: { subscriptionStatus: async () => ({ isPro: false, appleSubscriptionBound: true, plan: 'monthly' }) },
        appleSubscriptions: {
            resolveStoreKitScope: async () => undefined,
            usage: async () => ({ subscriberDailyRemaining: 0 }),
            attach: async () => ({ success: true, isPro: false }),
        },
    }));
    const server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
    try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/credits/subscription`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: 'DUMMYABC', storeKitProofs: ['PRIVATE-PROOF'] }),
        });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { subscriberDailyRemaining: 0, status: 'inactive',
            appleSubscriptionBound: true, subscriptionIdentityVersion: 1, plan: 'monthly', expiresAt: null });
        const proof = await fetch(`http://127.0.0.1:${server.address().port}/api/credits/apple-subscription`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: 'DUMMYABC', transactions: ['PRIVATE-PROOF'] }),
        });
        assert.deepEqual(await proof.json(), { success: true, isPro: false });
        fail = true;
        const failed = await fetch(`http://127.0.0.1:${server.address().port}/api/credits/subscription`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'DUMMYABC' }),
        });
        assert.equal(failed.status, 500);
        await failed.text();
        assert.equal(logs.length, 3);
        assert.ok(logs[0][1].spans.some(span => span.operation === 'db.wallet.findOne'));
        assert.equal(logs[1][1].operation, 'subscription_proof_verification');
        assert.equal(logs[2][1].httpStatus, 500);
        assert.doesNotMatch(JSON.stringify({ logs, errors }), /PRIVATE|DUMMYABC/);
    } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
});
