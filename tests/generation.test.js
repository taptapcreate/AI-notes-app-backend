const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const mongoose = require('mongoose');
const express = require('express');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const User = require('../models/User');
const GenerationRequest = require('../models/GenerationRequest');
const CreditRegistration = require('../models/CreditRegistration');
const PurchaseClaim = require('../models/PurchaseClaim');
const { createCredits } = require('../services/credits');
const { createGeneration } = require('../services/generation');
const { createPurchases } = require('../services/purchases');
let mongo, config, time, credits, generation, member, calls;
before(async () => {
    mongo = await MongoMemoryReplSet.create({
        binary: { version: '8.0.17' },
        replSet: { count: 1 },
    });
    await mongoose.connect(mongo.getUri(), { dbName: 'generation_tests' });
    await Promise.all([
        User.init(),
        GenerationRequest.init(),
        CreditRegistration.init(),
        PurchaseClaim.init(),
    ]);
});
after(async () => {
    await mongoose.disconnect();
    await mongo?.stop();
});
beforeEach(async () => {
    await Promise.all([
        User.deleteMany({}),
        GenerationRequest.deleteMany({}),
        CreditRegistration.deleteMany({}),
        PurchaseClaim.deleteMany({}),
    ]);
    config = {
        dailyFreeCreditsEnabled: false,
        freeDailyCredits: 2,
        subscriberDailyLimit: 2,
    };
    time = new Date();
    member = { isPro: false };
    calls = 0;
    credits = createCredits({
        User,
        CreditRegistration,
        PurchaseClaim,
        getAppConfig: async () => config,
        now: () => new Date(time),
    });
    generation = createGeneration({
        User,
        GenerationRequest,
        credits,
        getAppConfig: async () => config,
        entitlement: async () => {
            if (member instanceof Error) throw member;
            return member;
        },
        now: () => new Date(time),
    });
});
const source = { type: 'text', content: 'Explain a queue', isPro: true };
const account = async () =>
    (await credits.register({ deviceId: randomUUID() })).recoveryCode;
const reserve = (code, id = randomUUID(), body = source) =>
    generation.begin(code, id, '/notes', body);
async function api(t, handler, service = generation) {
    const app = express();
    app.use(express.json());
    app.use('/api', service.middleware);
    app.post('/api/notes', async (req, res) => {
        calls++;
        if (handler) await handler(req, res);
        else res.json({ notes: 'A useful note', pro: req.body.isPro });
    });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(
        () =>
            new Promise((resolve) => {
                server.closeAllConnections();
                server.close(resolve);
            }),
    );
    return async (code, id, body = source, path = '/api/notes') => {
        const response = await fetch(
            `http://127.0.0.1:${server.address().port}${path}`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(code ? { Authorization: `Bearer ${code}` } : {}),
                    ...(id ? { 'Idempotency-Key': id } : {}),
                },
                body: JSON.stringify(body),
            },
        );
        return { status: response.status, body: await response.json() };
    };
}
test('generation requires account credentials, request identity and valid input before calling AI', async (t) => {
    const code = await account();
    const request = await api(t);
    assert.equal((await request(null, randomUUID())).status, 426);
    assert.equal((await request('UNKNOWNX', randomUUID())).status, 401);
    assert.equal((await request(code)).status, 400);
    assert.equal(
        (await request(code, randomUUID(), { type: 'text', content: '' }))
            .status,
        400,
    );
    assert.equal(
        (await request(code, randomUUID(), source, '/api/notes/stream')).status,
        410,
    );
    assert.equal(calls, 0);
    assert.equal((await credits.balance(code)).totalAvailable, 7);
});
test('seven successful generations cost exactly seven; the eighth never reaches AI', async (t) => {
    const code = await account();
    const request = await api(t);
    for (let i = 0; i < 7; i++) {
        const result = await request(code, randomUUID());
        assert.equal(result.status, 200);
        assert.equal(result.body.pro, false);
        assert.equal(result.body.billing.creditBalance.totalAvailable, 6 - i);
    }
    assert.equal((await request(code, randomUUID())).status, 402);
    assert.equal(calls, 7);
});
test('a completed request replays its result without another model call or charge', async (t) => {
    const code = await account();
    const request = await api(t);
    const id = randomUUID();
    const first = await request(code, id);
    const again = await request(code, id);
    assert.equal(again.body.notes, first.body.notes);
    assert.equal(calls, 1);
    assert.equal((await credits.balance(code)).totalAvailable, 6);
    assert.equal(
        (await request(code, id, { ...source, content: 'Different' })).status,
        409,
    );
});
test('parallel unique reservations cannot overdraw the available balance', async () => {
    const code = await account();
    const results = await Promise.allSettled(
        Array.from({ length: 14 }, () => reserve(code)),
    );
    assert.equal(results.filter((x) => x.status === 'fulfilled').length, 7);
    assert.equal((await credits.balance(code)).totalAvailable, 0);
    assert.equal(await GenerationRequest.countDocuments(), 7);
});
test('concurrent retries of one request reserve only once and remain pending until completion', async () => {
    const code = await account();
    const id = randomUUID();
    const results = await Promise.allSettled(
        Array.from({ length: 10 }, () => reserve(code, id)),
    );
    assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1);
    assert.equal((await credits.balance(code)).totalAvailable, 6);
    assert.equal(await GenerationRequest.countDocuments(), 1);
});
test('provider failures refund once and cached errors do not rerun AI', async (t) => {
    const code = await account();
    const request = await api(t, (_, res) =>
        res.status(500).json({ error: 'Provider failed' }),
    );
    const id = randomUUID();
    assert.equal((await request(code, id)).status, 500);
    assert.equal((await request(code, id)).status, 500);
    assert.equal(calls, 1);
    assert.equal((await credits.balance(code)).totalAvailable, 7);
});
test('empty AI results are not charged', async (t) => {
    const code = await account();
    const request = await api(t, (_, res) => res.json({ notes: '' }));
    assert.equal((await request(code, randomUUID())).status, 502);
    assert.equal((await credits.balance(code)).totalAvailable, 7);
});
test('abandoned reservations recover after a restart and never refund twice', async () => {
    const code = await account();
    const { record } = await reserve(code);
    time = new Date(time.getTime() + 180001);
    await Promise.all([
        generation.recoverExpired(),
        generation.recoverExpired(),
    ]);
    assert.equal((await credits.balance(code)).totalAvailable, 7);
    const late = await generation.finish(record._id, 200, {
        notes: 'Late output',
    });
    assert.equal(late.state, 'failed');
    assert.equal(late.httpStatus, 504);
    assert.equal((await credits.balance(code)).totalAvailable, 7);
});
test('HTTP timeouts refund and ignore late provider output', async (t) => {
    const code = await account();
    const short = createGeneration({
        User,
        GenerationRequest,
        credits,
        getAppConfig: async () => config,
        entitlement: async () => ({ isPro: false }),
        leaseMs: 30,
    });
    const request = await api(
        t,
        async (_, res) => {
            await new Promise((r) => setTimeout(r, 100));
            res.json({ notes: 'Too late' });
        },
        short,
    );
    assert.equal((await request(code, randomUUID())).status, 504);
    await new Promise((r) => setTimeout(r, 120));
    assert.equal((await credits.balance(code)).totalAvailable, 7);
});
test('verified subscription usage is server limited and does not spend credit balances', async (t) => {
    const code = await account();
    member = { isPro: true };
    const request = await api(t);
    assert.equal(
        (await request(code, randomUUID())).body.billing.hasProSubscription,
        true,
    );
    assert.equal((await request(code, randomUUID())).status, 200);
    assert.equal((await request(code, randomUUID())).status, 429);
    assert.equal(calls, 2);
    assert.equal((await credits.balance(code)).totalAvailable, 7);
});
test('failed subscription generations return their daily reservation', async () => {
    const code = await account();
    member = { isPro: true };
    const { record } = await reserve(code);
    await generation.finish(record._id, 500, { error: 'Failed' });
    await generation.finish(record._id, 500, { error: 'Failed' });
    assert.equal((await credits.byCode(code)).dailyRequestCount, 0);
});
test('subscription verification outages do not consume credits or run AI', async (t) => {
    const code = await account();
    member = new Error('Verification down');
    const request = await api(t);
    assert.equal((await request(code, randomUUID())).status, 503);
    assert.equal(calls, 0);
    assert.equal((await credits.balance(code)).totalAvailable, 7);
});
test('RevenueCat subscription status honors expiry, grace, known products and sandbox isolation', async () => {
    let subscriber;
    const purchases = createPurchases({
        credits,
        apiKey: 'test-key',
        axios: { get: async () => ({ data: { subscriber } }) },
    });
    const product = 'ai_notes_pro_weekly_subscription';
    subscriber = {
        entitlements: {
            pro: { product_identifier: product, expires_date: '2000-01-01' },
        },
        subscriptions: {},
    };
    assert.equal(
        (await purchases.subscriptionStatus({ recoveryCode: 'TESTCODE' }))
            .isPro,
        false,
    );
    subscriber.subscriptions[product] = {
        grace_period_expires_date: '2099-01-01',
    };
    assert.equal(
        (await purchases.subscriptionStatus({ recoveryCode: 'TESTCODE' }))
            .isPro,
        true,
    );
    subscriber.subscriptions[product].is_sandbox = true;
    subscriber.subscriptions[product].store = 'play_store';
    assert.equal(
        (await purchases.subscriptionStatus({ recoveryCode: 'TESTCODE' }))
            .isPro,
        false,
    );
    subscriber.entitlements.pro = {
        product_identifier: 'unknown',
        expires_date: null,
    };
    assert.equal(
        (await purchases.subscriptionStatus({ recoveryCode: 'TESTCODE' }))
            .isPro,
        false,
    );
});

test('staged deployment keeps legacy clients working until strict cutover', async (t) => {
    config.generationBillingRequired = false;
    const request = await api(t);
    assert.equal((await request(null, null)).status, 200);
    assert.equal(calls, 1);
    const code = await account();
    const billed = await request(code, randomUUID());
    assert.equal(billed.body.billing.version, 2);
    assert.equal((await credits.balance(code)).totalAvailable, 6);
    config.generationBillingRequired = true;
    assert.equal((await request(null, null)).status, 426);
    assert.equal(calls, 2);
});

test('purged result content leaves an idempotency record and cannot charge a late retry again', async () => {
    const code = await account();
    const id = randomUUID();
    const { record } = await reserve(code, id);
    await generation.finish(record._id, 200, { notes: 'Original result' });
    time = new Date(time.getTime() + 86400001);
    await generation.recoverExpired();
    const retry = await reserve(code, id);
    assert.equal(retry.cached, true);
    await assert.rejects(
        generation.response(retry.record),
        (error) => error.status === 410,
    );
    assert.equal((await credits.balance(code)).totalAvailable, 6);
    assert.equal(await GenerationRequest.countDocuments(), 1);
});

test('shared subscription usage resets at the server UTC boundary without touching paid credits', async () => {
    time = new Date('2026-11-12T23:59:59.000Z');
    const code = await account();
    member = { isPro: true };
    await User.updateOne({ recoveryCode: code }, { $set: { credits: 5 } });
    const { record } = await reserve(code);
    await generation.finish(record._id, 200, { notes: 'Saved' });
    const before = await credits.balance(code);
    assert.equal(before.subscriberDailyUsage, 1);
    assert.equal(before.subscriberDailyRemaining, 1);
    assert.equal(before.subscriberResetAt, '2026-11-13T00:00:00.000Z');
    time = new Date('2026-11-13T00:00:00.000Z');
    const after = await credits.balance(code);
    assert.equal(after.subscriberDailyUsage, 0);
    assert.equal(after.subscriberDailyRemaining, 2);
    assert.equal(after.credits, 5);
});
test('concurrent devices share one allowance and paid fallback requires an explicit request', async (t) => {
    const code = await account();
    member = { isPro: true };
    await User.updateOne({ recoveryCode: code }, { $set: { credits: 3 } });
    const request = await api(t);
    const results = await Promise.all(Array.from({ length: 6 }, () => request(code, randomUUID())));
    assert.equal(results.filter(result => result.status === 200).length, 2);
    const blocked = results.find(result => result.status === 429).body;
    assert.equal(blocked.code, 'SUBSCRIPTION_DAILY_LIMIT');
    assert.equal(blocked.purchasedCreditsAvailable, 3);
    assert.equal((await credits.balance(code)).credits, 3);
    const id = randomUUID();
    const body = { ...source, billingMode: 'purchased' };
    const paid = await request(code, id, body);
    assert.equal(paid.status, 200);
    assert.equal(paid.body.billing.creditCost, 1);
    assert.equal(paid.body.billing.hasProSubscription, true);
    assert.equal(paid.body.pro, true);
    assert.equal(paid.body.billing.subscriberDailyUsage, 2);
    await request(code, id, body);
    assert.equal((await credits.balance(code)).credits, 2);
});
test('a Pro limit override applies only to that account and removing it keeps the usage count', async (t) => {
    const custom = await account();
    const standard = await account();
    member = { isPro: true };
    const request = await api(t);
    assert.equal((await request(custom, randomUUID())).status, 200);
    await User.updateOne({ recoveryCode: custom }, { $set: { subscriberDailyLimitOverride: 3 } });

    const balance = await credits.balance(custom);
    assert.equal(balance.subscriberDailyLimit, 3);
    assert.equal(balance.subscriberDailyRemaining, 2);
    assert.equal((await request(custom, randomUUID())).status, 200);
    const third = await request(custom, randomUUID());
    assert.equal(third.status, 200);
    assert.equal(third.body.billing.subscriberDailyLimit, 3);
    assert.equal(third.body.billing.subscriberDailyRemaining, 0);
    assert.equal(third.body.billing.creditBalance.freeCreditsRemaining, 7);
    const blocked = await request(custom, randomUUID());
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.subscriberDailyLimit, 3);

    assert.equal((await credits.balance(standard)).subscriberDailyLimit, 2);
    assert.equal((await credits.balance(standard)).subscriberDailyUsage, 0);

    await User.updateOne({ recoveryCode: custom }, { $unset: { subscriberDailyLimitOverride: '' } });
    const inherited = await credits.balance(custom);
    assert.equal(inherited.subscriberDailyLimit, 2);
    assert.equal(inherited.subscriberDailyUsage, 3);
    assert.equal(inherited.subscriberDailyRemaining, 0);
    assert.equal((await request(custom, randomUUID())).status, 429);

    member = { isPro: false };
    await User.updateOne({ recoveryCode: custom }, { $set: { subscriberDailyLimitOverride: 20 } });
    const nonPro = await request(custom, randomUUID());
    assert.equal(nonPro.status, 200);
    assert.equal(nonPro.body.billing.hasProSubscription, false);
    assert.equal(nonPro.body.billing.creditBalance.freeCreditsRemaining, 6);
    assert.equal(nonPro.body.billing.subscriberDailyUsage, 3);
});

test('failed paid fallback refunds only the purchased credit and preserves daily usage', async () => {
    const code = await account();
    member = { isPro: true };
    await User.updateOne({ recoveryCode: code }, { $set: { credits: 1 } });
    const before = await credits.balance(code);
    const { record } = await reserve(code, randomUUID(), { ...source, billingMode: 'purchased' });
    await generation.finish(record._id, 500, { error: 'Provider failed' });
    const after = await credits.balance(code);
    assert.equal(after.credits, before.credits);
    assert.equal(after.freeCreditsRemaining, before.freeCreditsRemaining);
    assert.equal(after.subscriberDailyUsage, before.subscriberDailyUsage);
    await assert.rejects(reserve(code, randomUUID(), { ...source, billingMode: 'invalid' }), error => error.status === 400);
});


test('verified Apple sandbox Pro uses only its own daily allowance at zero credits', async (t) => {
    const tester = await account();
    const other = await account();
    await User.updateOne({ recoveryCode: tester }, { $set: { totalFreeCredits: 0 } });

    const product = 'ai_notes_pro_monthly_subscription';
    const subscription = { is_sandbox: true, store: 'mac_app_store' };
    const entitlement = { product_identifier: product, expires_date: '2099-01-01' };
    const subscriber = {
        entitlements: { pro: entitlement },
        subscriptions: { [product]: subscription },
        non_subscriptions: {
            ai_notes_lite_pack_credits: [{ id: 'sandbox-credit-pack', is_sandbox: true }],
        },
    };
    const purchases = createPurchases({
        credits,
        apiKey: 'test-key',
        axios: {
            get: async (url) => ({
                data: { subscriber: url.endsWith('/' + tester) ? subscriber : {} },
            }),
        },
    });
    assert.deepEqual(await purchases.sync(await credits.byCode(tester)), { synced: 0, credits: 0 });
    const service = createGeneration({
        User, GenerationRequest, credits,
        getAppConfig: async () => config,
        entitlement: purchases.subscriptionStatus,
        now: () => new Date(time),
    });
    const request = await api(t, null, service);
    const first = await request(tester, randomUUID());
    assert.equal(first.status, 200);
    assert.equal(first.body.billing.creditCost, 0);
    assert.equal(first.body.billing.subscriberDailyRemaining, 1);

    subscription.store = 'app_store';
    config.subscriberDailyLimit = 15;
    const second = await request(tester, randomUUID());
    assert.equal(second.status, 200);
    assert.equal(second.body.billing.subscriberDailyLimit, 15);
    assert.equal(second.body.billing.subscriberDailyRemaining, 13);
    assert.equal((await credits.balance(tester)).totalAvailable, 0);
    const otherBalance = await credits.balance(other);
    assert.equal(otherBalance.totalAvailable, 7);
    assert.equal(otherBalance.subscriberDailyUsage, 0);

    entitlement.expires_date = '2000-01-01';
    assert.equal((await request(tester, randomUUID())).status, 402);
});
