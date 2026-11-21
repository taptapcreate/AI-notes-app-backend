const AccountRecovery = require('../models/AccountRecovery');
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
    await AccountRecovery.deleteMany({});
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

test('completion receipts avoid the full balance refresh and retries still report fresh counters', async t => {
    const code = await account();
    const originalBalance = credits.balance;
    let fullReads = 0, receiptReads = 0;
    credits.balance = async (...args) => { fullReads++; return originalBalance(...args); };
    const originalReceipt = credits.receiptBalance;
    credits.receiptBalance = async (...args) => { receiptReads++; return originalReceipt(...args); };
    const request = await api(t);
    const id = randomUUID();
    assert.equal((await request(code, id)).body.billing.creditBalance.totalAvailable, 6);
    assert.equal(fullReads, 1, 'only the pre-reservation initialization uses the full balance path');
    assert.equal(receiptReads, 1);
    await credits.grantPurchase(code, ['receipt-later-payment'], 10, 'test');
    assert.equal((await request(code, id)).body.billing.creditBalance.totalAvailable, 16);
    assert.equal(calls, 1); assert.equal(fullReads, 1); assert.equal(receiptReads, 2);
});

test('a receipt outage preserves the committed result for retry and timing observers cannot lose it', async t => {
    const code = await account(), metrics = [];
    const service = createGeneration({ User, GenerationRequest, credits, getAppConfig: async () => config,
        entitlement: async () => member, now: () => new Date(time), onTiming: value => { metrics.push(value); throw new Error('observer failed'); } });
    const original = credits.receiptBalance; let failed = true;
    credits.receiptBalance = async (...args) => { if (failed) throw new Error('temporary receipt failure'); return original(...args); };
    const request = await api(t, undefined, service), id = randomUUID();
    assert.equal((await request(code, id)).status, 503);
    const committed = await GenerationRequest.findOne({ requestId: id }).lean();
    assert.equal(committed.state, 'succeeded');
    failed = false; const retry = await request(code, id);
    assert.equal(retry.status, 200); assert.equal(retry.body.billing.creditBalance.totalAvailable, 6); assert.equal(calls, 1);
    assert.equal(metrics.length, 1); assert.equal(metrics[0].receiptCompleted, false);
    assert.ok(metrics[0].settlementMs >= 0); assert.ok(metrics[0].receiptMs >= 0);
    assert.doesNotMatch(JSON.stringify(metrics), new RegExp(code));
});

test('authenticated extraction scope is isolated between accounts and diagnostics cannot fail completion', async t => {
    const a = await account(), b = await account(), seen = [], metrics = [];
    const service = createGeneration({ User, GenerationRequest, credits, getAppConfig: async () => config,
        entitlement: async () => member, now: () => new Date(time), onTiming: value => { metrics.push(value); throw new Error('observer failed'); } });
    const request = await api(t, async (_req, res) => {
        const scope = require('../services/generation-context').context.getStore();
        seen.push(scope.accountScope); res.json({ notes: 'Scope-safe result' });
    }, service);
    assert.equal((await request(a, randomUUID())).status, 200); assert.equal((await request(b, randomUUID())).status, 200);
    assert.notEqual(seen[0], seen[1]); assert.match(seen[0], /^[a-f0-9]{64}$/);
    assert.equal(metrics.length, 2); assert.ok(metrics.every(value => value.receiptCompleted && value.finalizationMs >= 0));
});

test('parallel accounts retain their own extraction scope across asynchronous provider work', async t => {
    const a = await account(), b = await account(), seen = [];
    let release; const both = new Promise(resolve => { release = resolve; });
    const request = await api(t, async (req, res) => {
        const context = require('../services/generation-context').context;
        const before = context.getStore().accountScope;
        seen.push({ content: req.body.content, before }); if (seen.length === 2) release();
        await both;
        const after = context.getStore().accountScope;
        assert.equal(before, after); res.json({ notes: req.body.content });
    });
    const results = await Promise.all([
        request(a, randomUUID(), { ...source, content: 'Account A recording' }),
        request(b, randomUUID(), { ...source, content: 'Account B recording' }),
    ]);
    assert.deepEqual(results.map(value => value.status), [200, 200]);
    assert.notEqual(seen[0].before, seen[1].before);
    for (const [code, content] of [[a, 'Account A recording'], [b, 'Account B recording']])
        assert.equal(seen.find(value => value.content === content).before,
            require('node:crypto').createHash('sha256').update(code).digest('hex'));
});
async function api(t, handler, service = generation) {
    const app = express();
    app.use(express.json({ limit: '25mb' }));
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
    const retry = await reserve(code, id);
    assert.equal(retry.cached, true);
    assert.deepEqual(retry.record.result, { notes: 'Original result' });
    await assert.rejects(
        generation.response(retry.record),
        (error) => error.status === 410,
    );
    await generation.recoverExpired();
    const purged = await GenerationRequest.findById(record._id).lean();
    assert.equal(purged.result, undefined);
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
test('lifetime credit fallback requires consent, never substitutes another balance, and honors the reset', async (t) => {
    time = new Date('2026-11-12T23:59:59.000Z');
    const code = await account();
    member = { isPro: true };
    config.subscriberDailyLimit = 1;
    await User.updateOne({ recoveryCode: code }, { $set: { totalFreeCredits: 1, adCredits: 3 } });
    const request = await api(t);

    const included = await request(code, randomUUID());
    assert.equal(included.body.billing.creditCost, 0);
    assert.equal(included.body.billing.creditBalance.freeCreditsRemaining, 1);
    const blocked = await request(code, randomUUID());
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.freeCreditsAvailable, 1);
    assert.equal(blocked.body.purchasedCreditsAvailable, 0);
    assert.equal(blocked.body.subscriberResetAt, '2026-11-13T00:00:00.000Z');

    const fallback = { ...source, billingMode: 'free' };
    const { record } = await reserve(code, randomUUID(), fallback);
    await generation.finish(record._id, 500, { error: 'Provider failed' });
    assert.equal((await credits.balance(code)).freeCreditsRemaining, 1);
    await User.updateOne({ recoveryCode: code }, { $set: { credits: 2 } });
    const id = randomUUID();
    const used = await request(code, id, fallback);
    assert.equal(used.status, 200);
    assert.equal(used.body.billing.creditBalance.freeCreditsRemaining, 0);
    assert.equal(used.body.billing.creditBalance.credits, 2);
    assert.equal(used.body.billing.creditBalance.adCredits, 3);
    assert.equal((await request(code, id, fallback)).status, 200);
    const staleChoice = await request(code, randomUUID(), fallback);
    assert.equal(staleChoice.status, 429);
    assert.equal(staleChoice.body.freeCreditsAvailable, 0);
    assert.equal(staleChoice.body.purchasedCreditsAvailable, 2);

    time = new Date('2026-11-13T00:00:00.000Z');
    const afterReset = await request(code, randomUUID(), { ...source, billingMode: 'purchased' });
    assert.equal(afterReset.status, 200);
    assert.equal(afterReset.body.billing.creditCost, 0);
    assert.equal(afterReset.body.billing.creditBalance.credits, 2);
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

test('request-history fallback repairs an incorrect primary count and toggling modes cannot refill the allowance', async () => {
    const code = await account();
    member = { isPro: true };
    const first = await reserve(code);
    await generation.finish(first.record._id, 200, { notes: 'First note' });
    await User.updateOne({ recoveryCode: code }, { $set: { dailyRequestCount: 9999, lastRequestReset: time } });
    assert.equal((await credits.balance(code)).subscriberDailyRemaining, 0);
    config.billingControls = { usePrimarySubscriptionTracking: false };
    assert.equal((await credits.balance(code)).subscriberDailyRemaining, 1);
    const second = await reserve(code);
    await generation.finish(second.record._id, 200, { notes: 'Second note' });
    await assert.rejects(reserve(code), error => error.status === 429);
    config.billingControls.usePrimarySubscriptionTracking = true;
    await assert.rejects(reserve(code), error => error.status === 429);
    config.billingControls.usePrimarySubscriptionTracking = false;
    const replay = await reserve(code, second.record.requestId);
    assert.equal(replay.cached, true);
    assert.equal((await credits.balance(code)).subscriberDailyRemaining, 0);
    time = new Date(time);
    time.setUTCDate(time.getUTCDate() + 1);
    assert.equal((await credits.balance(code)).subscriberDailyRemaining, 2);
});

test('fallback reservations remain atomic and failures release their allowance exactly once', async () => {
    const code = await account();
    member = { isPro: true };
    config.billingControls = { usePrimarySubscriptionTracking: false };
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => reserve(code)));
    const granted = results.filter(result => result.status === 'fulfilled').map(result => result.value);
    assert.equal(granted.length, 2);
    assert.equal((await credits.balance(code)).subscriberDailyRemaining, 0);
    await generation.finish(granted[0].record._id, 500, { error: 'Provider failed' });
    await generation.finish(granted[0].record._id, 500, { error: 'Provider failed' });
    assert.equal((await credits.balance(code)).subscriberDailyRemaining, 1);
    await reserve(code);
    assert.equal((await credits.balance(code)).subscriberDailyRemaining, 0);
    assert.equal((await credits.balance(code)).totalAvailable, 7);
});

test('a client-provided counter cannot bypass the protected fallback', async () => {
    const code = await account();
    member = { isPro: true };
    config.billingControls = { usePrimarySubscriptionTracking: false };
    await reserve(code);
    await reserve(code);
    await assert.rejects(reserve(code, randomUUID(), { ...source, localSubscriptionUsage: { used: 0 } }),
        error => error.status === 429);
    member = { isPro: false };
    const paid = await reserve(code, randomUUID(), { ...source, isPro: true, localSubscriptionUsage: { used: 0 } });
    assert.equal(paid.record.reservation.pro, false);
});


test('request-history fallback preserves ten-per-day usage when the primary counter is deleted', async () => {
    const code = await account();
    member = { isPro: true };
    config.subscriberDailyLimit = 10;
    for (let i = 0; i < 3; i++) {
        const request = await reserve(code);
        await generation.finish(request.record._id, 200, { notes: 'Verified note' });
    }
    const before = await credits.balance(code);
    assert.equal(before.subscriberDailyRemaining, 7);
    config.billingControls = { usePrimarySubscriptionTracking: false };
    await User.updateOne({ recoveryCode: code }, { $unset: { dailyRequestCount: 1 } });
    const fallback = await credits.balance(code);
    assert.equal(fallback.subscriptionTrackingSource, 'requestHistory');
    assert.equal(fallback.subscriberDailyUsage, 3);
    assert.equal(fallback.subscriberDailyRemaining, 7);
    const next = await reserve(code);
    await generation.finish(next.record._id, 200, { notes: 'Fourth note' });
    assert.equal((await credits.balance(code)).subscriberDailyRemaining, 6);
    assert.equal((await credits.byCode(code)).dailyRequestCount, 4);
    await reserve(code, next.record.requestId);
    assert.equal((await credits.balance(code)).subscriberDailyRemaining, 6);
    config.billingControls.usePrimarySubscriptionTracking = true;
    const primary = await credits.balance(code);
    assert.equal(primary.subscriberDailyRemaining, 6);
    assert.equal(primary.totalAvailable, before.totalAvailable);
});


test('pending purchased charge and refund survive wallet deletion exactly once', async () => {
    const code = await account();
    await credits.grantPurchase(code, ['verified-topup'], 20, 'store');
    await credits.use(code, 7);
    const request = await reserve(code);
    assert.equal((await credits.balance(code)).credits, 19);
    await User.deleteOne({ recoveryCode: code });
    await generation.finish(request.record._id, 500, { error: 'Provider failed' });
    assert.equal((await credits.balance(code)).credits, 20);
    await User.deleteOne({ recoveryCode: code });
    await generation.finish(request.record._id, 500, { error: 'Duplicate failure' });
    assert.equal((await credits.balance(code)).credits, 20);
    assert.equal((await credits.balance(code)).freeCreditsRemaining, 0);
});


async function streamAPI(t, handler) {
 const app=express();app.use(express.json({ limit: '25mb' }));app.use('/api',generation.middleware);
 app.post('/api/notes',async(req,res)=>{calls++;await handler(req,res);});
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
 return `http://127.0.0.1:${server.address().port}/api/notes`;
}
test('streamed previews commit once and JSON retry replays the same paid result',async t=>{
 const code=await account(),id=randomUUID();let release,started;
 const proceed=new Promise(r=>release=r),ready=new Promise(r=>started=r);
 const url=await streamAPI(t,async(req,res)=>{req.noteStream.delta('Live ');started();await proceed;req.noteStream.delta('note');res.json({notes:'Live note'});});
 const result=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${code}`,'Idempotency-Key':id,Accept:'text/event-stream'},body:JSON.stringify(source)});
 assert.match(result.headers.get('content-type'),/text\/event-stream/);const reader=result.body.getReader(),decoder=new TextDecoder();await ready;
 let text='';while(!text.includes('Live ')){text+=decoder.decode((await reader.read()).value);}
 assert.equal(text.includes('complete'),false);assert.equal((await GenerationRequest.findOne({requestId:id})).state,'pending');release();
 while(true){const part=await reader.read();if(part.done)break;text+=decoder.decode(part.value);}
 const frames=text.split('\n\n').filter(x=>x.startsWith('data:')).map(x=>JSON.parse(x.slice(5)));
 const final=frames.find(x=>x.type==='complete');assert.equal(final.status,200);assert.equal(final.body.notes,'Live note');assert.equal(final.body.billing.charged,true);assert.equal(final.body.billing.creditCost,1);
 assert.equal((await GenerationRequest.findOne({requestId:id})).state,'succeeded');
 const again=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${code}`,'Idempotency-Key':id},body:JSON.stringify(source)});
 assert.equal((await again.json()).notes,'Live note');assert.equal(calls,1);assert.equal((await credits.balance(code)).freeCreditsRemaining,6);
});
test('stream failure refunds the held credit and returns a terminal failure receipt',async t=>{
 const code=await account(),id=randomUUID();const before=await credits.balance(code);
 const url=await streamAPI(t,async(req,res)=>{req.noteStream.delta('Incomplete');res.status(502).json({error:'Upstream disconnected'});});
 const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${code}`,'Idempotency-Key':id,Accept:'text/event-stream'},body:JSON.stringify(source)});
 const frames=(await response.text()).split('\n\n').filter(x=>x.startsWith('data:')).map(x=>JSON.parse(x.slice(5)));const final=frames.find(x=>x.type==='complete');
 assert.equal(final.status,502);assert.equal(final.body.billing.charged,false);assert.equal((await credits.balance(code)).freeCreditsRemaining,before.freeCreditsRemaining);
});
test('a disconnected preview still saves the paid result for a same-ID retry',async t=>{
 const code=await account(),id=randomUUID();let release;const wait=new Promise(r=>release=r);
 const url=await streamAPI(t,async(req,res)=>{req.noteStream?.delta('First');await wait;res.json({notes:'Recovered final note'});});
 const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${code}`,'Idempotency-Key':id,Accept:'text/event-stream'},body:JSON.stringify(source)});
 const reader=response.body.getReader();await reader.read();await reader.cancel();release();
 for(let tries=0;tries<100;tries++){if((await GenerationRequest.findOne({requestId:id})).state==='succeeded')break;await new Promise(r=>setTimeout(r,10));}
 const replay=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${code}`,'Idempotency-Key':id,Accept:'text/event-stream'},body:JSON.stringify(source)});
 const final=(await replay.text()).split('\n\n').filter(x=>x.startsWith('data:')).map(x=>JSON.parse(x.slice(5))).find(x=>x.type==='complete');
 assert.equal(final.body.notes,'Recovered final note');assert.equal(final.body.billing.charged,true);assert.equal(calls,1);assert.equal((await credits.balance(code)).freeCreditsRemaining,6);
});

function noteAudio(seconds) {
    const audio = Buffer.alloc(44 + seconds * 32000);
    audio.write('RIFF', 0);
    audio.writeUInt32LE(audio.length - 8, 4);
    audio.write('WAVEfmt ', 8);
    audio.writeUInt32LE(16, 16);
    audio.writeUInt16LE(1, 20);
    audio.writeUInt16LE(1, 22);
    audio.writeUInt32LE(16000, 24);
    audio.writeUInt32LE(32000, 28);
    audio.writeUInt16LE(2, 32);
    audio.writeUInt16LE(16, 34);
    audio.write('data', 36);
    audio.writeUInt32LE(audio.length - 44, 40);
    return audio.toString('base64');
}

test('desktop media charges two credits once and rejects oversize media before model execution', async (t) => {
    const { PDFDocument } = require('pdf-lib');
    const code = await account();
    const request = await api(t);
    const doc = await PDFDocument.create();
    for (let i = 0; i < 3; i++) doc.addPage();
    const pdf = { type: 'pdf', content: await doc.saveAsBase64(), desktopMediaBilling: 1 };
    const id = randomUUID();
    const result = await request(code, id, pdf);
    assert.equal(result.status, 200);
    assert.equal(result.body.billing.creditCost, 2);
    assert.equal((await request(code, id, pdf)).body.billing.creditBalance.totalAvailable, 5);
    for (let i = 3; i < 11; i++) doc.addPage();
    assert.equal((await request(code, randomUUID(), { ...pdf, content: await doc.saveAsBase64() })).status, 400);
    assert.equal((await request(code, randomUUID(), { type: 'voice', content: noteAudio(181), desktopMediaBilling: 1 })).status, 400);
    const narration = { type: 'image', sourceKind: 'walkthrough', content: 'AAAA', narration: noteAudio(61), desktopMediaBilling: 1 };
    assert.equal((await request(code, randomUUID(), narration)).status, 400);
    assert.equal(calls, 1);
    const audio = { type: 'voice', content: noteAudio(180), desktopMediaBilling: 1 };
    assert.equal((await request(code, randomUUID(), audio)).body.billing.creditCost, 2);
    assert.equal((await request(code, randomUUID(), { ...narration, narration: noteAudio(60) })).body.billing.creditCost, 2);
    assert.equal((await credits.balance(code)).totalAvailable, 1);
    assert.equal((await request(code, randomUUID(), audio)).status, 402);
    assert.equal(calls, 3);
});

test('desktop media reserves two Pro units, counts both in history, and refunds both on failure', async () => {
    const code = await account();
    member = { isPro: true };
    config.billingControls = { usePrimarySubscriptionTracking: false };
    const audio = { type: 'voice', content: noteAudio(1), desktopMediaBilling: 1 };
    const { record } = await reserve(code, randomUUID(), audio);
    assert.equal(record.reservation.proUnits, 2);
    assert.equal((await credits.balance(code)).subscriberDailyRemaining, 0);
    await generation.finish(record._id, 500, { error: 'Provider failed' });
    assert.equal((await credits.balance(code)).subscriberDailyRemaining, 2);
    await reserve(code);
    await assert.rejects(reserve(code, randomUUID(), audio), { status: 429 });
    const mixed = await reserve(code, randomUUID(), { ...audio, billingMode: 'free' });
    assert.equal(mixed.record.reservation.pro, true);
    assert.equal(mixed.record.reservation.free, 1);
    await generation.finish(mixed.record._id, 500, { error: 'Provider failed' });
    assert.equal((await credits.balance(code)).subscriberDailyRemaining, 1);
    assert.equal((await credits.balance(code)).totalAvailable, 7);
});

test('PDF billing verifies the number of selected pages before reserving credits', async (t) => {
    const { PDFDocument } = require('pdf-lib');
    const { generationUnits } = require('../services/media-note-billing');
    const code = await account();
    const request = await api(t);
    const doc = await PDFDocument.create();
    let pdf;
    for (const expected of [2, 2, 2, 3, 3, 3, 4, 4, 4, 5]) {
        doc.addPage();
        pdf = { type: 'pdf', content: await doc.saveAsBase64(), mobileMediaBilling: 1, pdfOcrCreditQuote: expected };
        assert.equal(await generationUnits('/notes', pdf), expected);
    }
    const wrong = await request(code, randomUUID(), { ...pdf, pdfOcrCreditQuote: 2 });
    assert.equal(wrong.status, 409);
    assert.match(wrong.body.error, /need 5 AI credits/);
    assert.equal((await credits.balance(code)).totalAvailable, 7);
    const id = randomUUID();
    assert.equal((await request(code, id, pdf)).body.billing.creditCost, 5);
    assert.equal((await request(code, id, pdf)).body.billing.creditBalance.totalAvailable, 2);
    assert.equal(calls, 1);
});

test('Video works on Free while paid-only mobile sources retain the backend gate', async (t) => {
    const code = await account();
    const request = await api(t);
    const video = { type: 'image', content: 'AAAA', appFeature: 'video', featurePolicyVersion: 1 };
    const id = randomUUID();
    const first = await request(code, id, video);
    assert.equal(first.status, 200);
    assert.equal(first.body.billing.totalCreditCost, 1);
    assert.equal((await request(code, id, video)).body.billing.creditBalance.totalAvailable,
        first.body.billing.creditBalance.totalAvailable);
    for (const appFeature of ['location', 'calendar', 'sketch']) {
        const result = await request(code, randomUUID(), { type: appFeature === 'sketch' ? 'image' : 'text',
            content: appFeature === 'sketch' ? 'AAAA' : 'Selected event or place', appFeature, featurePolicyVersion: 1 });
        assert.equal(result.status, 403);
        assert.equal(result.body.code, 'PRO_REQUIRED');
    }
    assert.equal(calls, 1);
});

test('both client transports use configured media pricing and stale quotes reserve nothing', async (t) => {
    const code = await account();
    const request = await api(t);
    config.generationMediaPricing = { audioExtra: 2 };
    const audio = { type: 'voice', content: noteAudio(1) };
    const stale = await request(code, randomUUID(), { ...audio, desktopMediaBilling: 1, mediaCreditQuote: 2 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, 'CREDIT_QUOTE_CHANGED');
    assert.equal(calls, 0);
    assert.equal((await credits.balance(code)).totalAvailable, 7);

    for (const client of ['desktopMediaBilling', 'mobileMediaBilling']) {
        const body = { ...audio, [client]: 1, mediaCreditQuote: 3 };
        const id = randomUUID();
        const first = await request(code, id, body);
        assert.equal(first.status, 200);
        assert.equal(first.body.billing.totalCreditCost, 3);
        assert.equal(first.body.billing.subscriptionCreditCost, 0);
        assert.equal((await request(code, id, body)).body.billing.creditBalance.totalAvailable,
            first.body.billing.creditBalance.totalAvailable);
    }
    assert.equal(calls, 2);
    assert.equal((await credits.balance(code)).totalAvailable, 1);
});
