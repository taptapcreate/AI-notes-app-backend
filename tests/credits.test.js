const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const express = require('express');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const User = require('../models/User');
const AppConfig = require('../models/AppConfig');
const CreditRegistration = require('../models/CreditRegistration');
const PurchaseClaim = require('../models/PurchaseClaim');
const PendingPurchase = require('../models/PendingPurchase');
const { createCredits } = require('../services/credits');
const { createPurchases } = require('../services/purchases');
const { createCreditRouter } = require('../routes/credits');
const { createRevenueCatHandler } = require('../routes/revenuecat');
const { createPurchaseAdminRouter } = require('../routes/purchase-admin');

let mongo, config, time, credits;
const logger = { error() {}, warn() {} };
before(async () => {
    mongo = await MongoMemoryServer.create({ binary: { version: '8.0.17' } });
    await mongoose.connect(mongo.getUri(), { dbName: 'ai_notes_credit_tests' });
    await Promise.all([
        User.init(),
        AppConfig.init(),
        CreditRegistration.init(),
        PurchaseClaim.init(),
        PendingPurchase.init(),
    ]);
});
after(async () => {
    await mongoose.disconnect();
    await mongo?.stop();
});
beforeEach(async () => {
    await Promise.all([
        User.deleteMany({}),
        AppConfig.deleteMany({}),
        CreditRegistration.deleteMany({}),
        PurchaseClaim.deleteMany({}),
        PendingPurchase.deleteMany({}),
    ]);
    config = {
        dailyFreeCreditsEnabled: false,
        freeDailyCredits: 2,
        welcomePackCredits: 7,
        welcomePackVersion: 1,
        adRewards: { enabled: false, active: false, standardReward: 2 },
    };
    time = new Date('2026-11-11T10:00:00.000Z');
    credits = createCredits({
        User,
        CreditRegistration,
        PurchaseClaim,
        getAppConfig: async () => config,
        now: () => new Date(time),
    });
});
const register = (deviceId = 'device-1') => credits.register({ platform: 'ios', deviceId });
const rejectsStatus = (promise, status) =>
    assert.rejects(promise, (error) => error.status === status);

async function withAPI(
    t,
    purchases = { sync: async () => ({ synced: 0, credits: 0 }) },
    webhookSecret = 'test-hook-secret',
) {
    const app = express();
    app.use(express.json());
    app.use('/api/credits', createCreditRouter({ credits, purchases, logger }));
    app.post(
        '/api/webhooks/revenuecat',
        createRevenueCatHandler({
            User,
            PendingPurchase,
            credits,
            reconcilePurchases: (user) => purchases.sync(user, { required: true }),
            secret: webhookSecret,
            logger,
        }),
    );
    app.use(
        '/api/admin',
        createPurchaseAdminRouter({
            PendingPurchase,
            credits,
            secret: 'test-admin-secret',
            logger,
        }),
    );
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(
        () =>
            new Promise((resolve) => {
                server.closeAllConnections();
                server.close(resolve);
            }),
    );
    return async (endpoint, body, authorization) => {
        const response = await fetch(`http://127.0.0.1:${server.address().port}${endpoint}`, {
            method: body === undefined ? 'GET' : 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(authorization ? { Authorization: authorization } : {}),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { status: response.status, body: await response.json() };
    };
}

test('new accounts receive exactly seven once, not the legacy configured eight', async () => {
    const account = await register();
    assert.equal(account.freeCreditsRemaining, 7);
    assert.equal(account.totalAvailable, 7);
    await credits.use(account.recoveryCode, 3);
    for (let day = 0; day < 3; day++) {
        time.setUTCDate(time.getUTCDate() + 1);
        assert.equal((await register()).freeCreditsRemaining, 4);
        assert.equal((await credits.balance(account.recoveryCode)).freeCreditsRemaining, 4);
    }
});

test('simultaneous registration of the same device creates one account and one grant', async () => {
    const accounts = await Promise.all(Array.from({ length: 24 }, () => register()));
    assert.equal(new Set(accounts.map((a) => a.recoveryCode)).size, 1);
    assert.equal(await User.countDocuments(), 1);
    assert.equal(await CreditRegistration.countDocuments(), 1);
    assert.ok(accounts.every((a) => a.freeCreditsRemaining === 7));
});

test('different and legacy anonymous clients can register without sharing a code', async () => {
    const accounts = await Promise.all([
        register('a'),
        register('b'),
        credits.register({}),
        credits.register({}),
    ]);
    assert.equal(new Set(accounts.map((a) => a.recoveryCode)).size, 4);
    assert.ok(accounts.every((a) => /^[A-Z2-9]{8}$/.test(a.recoveryCode)));
});

test('daily-mode users migrate once while paid and ad credits remain intact', async () => {
    await User.create({
        recoveryCode: 'LEGACYAA',
        deviceId: 'legacy',
        credits: 90,
        adCredits: 2,
        freeCreditsRemaining: 2,
        welcomePackVersion: 0,
    });
    const results = await Promise.all(
        Array.from({ length: 20 }, () => credits.balance('LEGACYAA')),
    );
    assert.ok(
        results.every((r) => r.freeCreditsRemaining === 7 && r.credits === 90 && r.adCredits === 2),
    );
    await credits.use('LEGACYAA', 7);
    assert.equal((await credits.balance('LEGACYAA')).freeCreditsRemaining, 0);
});

test('legacy users with missing fields receive one grant without a retry loop', async () => {
    await User.collection.insertOne({ recoveryCode: 'MISSINGA', credits: 0 });
    assert.equal((await credits.balance('MISSINGA')).freeCreditsRemaining, 7);
    await credits.use('MISSINGA', 7);
    assert.equal((await credits.balance('MISSINGA')).totalAvailable, 0);
});

test('existing welcome packs keep their remaining balance, even above seven', async () => {
    for (const [i, remaining] of [0, 2, 9].entries()) {
        const code = `OLDPACK${i}`;
        await User.create({
            recoveryCode: code,
            totalFreeCredits: remaining,
            welcomePackVersion: 1,
        });
        assert.equal((await credits.balance(code)).freeCreditsRemaining, remaining);
    }
});

test('client amounts and version bumps cannot replenish an exhausted welcome pack', async () => {
    const { recoveryCode: code } = await register();
    await credits.use(code, 7);
    config.welcomePackCredits = 5000;
    config.welcomePackVersion = 100;
    const result = await credits.syncWelcomePack(code, 10000, 999999);
    assert.equal(result.newBalance, 0);
    assert.equal(result.version, 1);
});

test('concurrent deductions never spend more than the seven available credits', async () => {
    const { recoveryCode: code } = await register();
    const results = await Promise.allSettled(
        Array.from({ length: 35 }, () => credits.use(code, 1)),
    );
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 7);
    assert.ok(results.filter((r) => r.status === 'rejected').every((r) => r.reason.status === 400));
    assert.equal((await credits.balance(code)).totalAvailable, 0);
});

test('deductions consume free, ad, then purchased credits in that order', async () => {
    const { recoveryCode: code } = await register();
    await User.updateOne(
        { recoveryCode: code },
        { $set: { totalFreeCredits: 3, adCredits: 2, credits: 10 } },
    );
    const result = await credits.use(code, 8);
    assert.equal(result.remainingFreeCredits, 0);
    assert.equal(result.remainingAdCredits, 0);
    assert.equal(result.remainingCredits, 7);
    assert.equal(result.totalAvailable, 7);
});

test('invalid or insufficient deductions never change a balance', async () => {
    const { recoveryCode: code } = await register();
    for (const amount of [0, -1, 0.5, '1', null, undefined, NaN, Infinity, 10001, {}]) {
        await rejectsStatus(credits.use(code, amount), 400);
    }
    await rejectsStatus(credits.use(code, 8), 400);
    assert.equal((await credits.balance(code)).totalAvailable, 7);
});

test('recovery shares the remaining allowance and preserves the previous account', async () => {
    const first = await register('first');
    const second = await register('second');
    await credits.use(first.recoveryCode, 5);
    const result = await credits.recover(first.recoveryCode.toLowerCase(), second.recoveryCode);
    assert.equal(result.freeCreditsRemaining, 2);
    assert.equal(result.totalAvailable, 2);
    assert.equal(await User.countDocuments(), 2);
    assert.equal((await register('first')).freeCreditsRemaining, 2);
    assert.equal((await register('second')).freeCreditsRemaining, 7);
});

test('invalid configuration fails closed without resetting or granting credits', async () => {
    const { recoveryCode: code } = await register();
    await credits.use(code, 2);
    for (const value of [null, {}, { dailyFreeCreditsEnabled: true, freeDailyCredits: -1 }]) {
        config = value;
        await rejectsStatus(credits.balance(code), 503);
        await rejectsStatus(register('new'), 503);
    }
    assert.equal((await User.findOne({ recoveryCode: code })).totalFreeCredits, 5);
});

test('existing daily mode continues working until the explicit policy switch', async () => {
    config.dailyFreeCreditsEnabled = true;
    const { recoveryCode: code } = await register();
    assert.equal((await credits.use(code, 2)).totalAvailable, 0);
    time.setUTCDate(time.getUTCDate() + 1);
    const results = await Promise.all(Array.from({ length: 10 }, () => credits.balance(code)));
    assert.ok(results.every((r) => r.freeCreditsRemaining === 2));
    config.dailyFreeCreditsEnabled = false;
    assert.equal((await credits.balance(code)).freeCreditsRemaining, 7);
    await credits.use(code, 7);
    config.dailyFreeCreditsEnabled = true;
    time.setUTCDate(time.getUTCDate() + 1);
    await credits.balance(code);
    config.dailyFreeCreditsEnabled = false;
    assert.equal((await credits.balance(code)).freeCreditsRemaining, 0);
});

test('unknown, malformed, and invalid existing balances fail without credits changes', async () => {
    await rejectsStatus(credits.balance('UNKNOWNX'), 404);
    await rejectsStatus(credits.balance({ $gt: '' }), 400);
    await rejectsStatus(register(''), 400);
    await rejectsStatus(credits.register({ platform: 'macos' }), 400);
    await rejectsStatus(credits.register([]), 400);
    await rejectsStatus(credits.register(null), 400);
    await User.create({
        recoveryCode: 'BADVALUE',
        credits: -1,
        totalFreeCredits: 1,
        welcomePackVersion: 1,
    });
    await rejectsStatus(credits.use('BADVALUE', 1), 503);
});

test('concurrent verified purchase retries apply exactly once', async () => {
    const { recoveryCode: code } = await register();
    const results = await Promise.all(
        Array.from({ length: 20 }, () =>
            credits.grantPurchase(code, ['store-tx-1', 'rc-tx-1'], 100, 'test'),
        ),
    );
    assert.equal(results.filter((r) => r.applied).length, 1);
    assert.equal((await credits.balance(code)).credits, 100);
});

test('one verified purchase cannot credit two accounts', async () => {
    const a = await register('a');
    const b = await register('b');
    const results = await Promise.allSettled(
        [a, b].map((account) =>
            credits.grantPurchase(account.recoveryCode, ['same-tx'], 100, 'test'),
        ),
    );
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(
        (await credits.balance(a.recoveryCode)).credits +
            (await credits.balance(b.recoveryCode)).credits,
        100,
    );
});

test('parallel purchases and deductions do not overwrite each other', async () => {
    const { recoveryCode: code } = await register();
    await User.updateOne({ recoveryCode: code }, { $set: { totalFreeCredits: 0, credits: 100 } });
    const results = await Promise.allSettled([
        ...Array.from({ length: 12 }, (_, i) =>
            credits.grantPurchase(code, [`tx-${i}`], 100, 'test'),
        ),
        ...Array.from({ length: 20 }, () => credits.use(code, 1)),
    ]);
    assert.ok(results.every((r) => r.status === 'fulfilled'));
    assert.equal((await credits.balance(code)).credits, 1280);
});

test('ad claims respect the disabled flag and grant at most once per day', async () => {
    const { recoveryCode: code } = await register();
    await rejectsStatus(credits.claimAd(code), 403);
    config.adRewards.enabled = true;
    config.adRewards.active = true;
    const results = await Promise.all(Array.from({ length: 15 }, () => credits.claimAd(code)));
    assert.equal(results.filter((r) => r.success).length, 1);
    assert.equal((await credits.balance(code)).adCredits, 2);
    assert.equal((await credits.balance(code)).totalAvailable, 9);
});

test('HTTP responses preserve mobile fields and ignore client welcome grant values', async (t) => {
    const api = await withAPI(t);
    const registered = await api('/api/credits/register', {
        platform: 'other',
        deviceId: 'desktop',
    });
    const code = registered.body.recoveryCode;
    assert.equal(registered.status, 200);
    const used = await api('/api/credits/use', { code, amount: 7 });
    assert.equal(used.body.remainingFreeCredits, 0);
    const synced = await api('/api/credits/sync-welcome-pack', {
        code,
        version: 999,
        credits: 999999,
    });
    assert.equal(synced.body.newBalance, 0);
    const recovered = await api('/api/credits/recover', {
        code,
        currentCode: null,
    });
    assert.equal(recovered.body.totalAvailable, 0);
    assert.equal((await api('/api/credits/balance/' + code)).body.freeCreditsRemaining, 0);
    assert.equal((await api('/api/credits/use', { code, amount: -1 })).status, 400);
});

test('purchase endpoint credits verified products, ignoring synthetic client IDs and amounts', async (t) => {
    const { recoveryCode: code } = await register();
    const purchases = createPurchases({
        credits,
        apiKey: 'test-server-key',
        axios: {
            get: async () => ({
                data: {
                    subscriber: {
                        non_subscriptions: {
                            ai_notes_lite_pack_credits: [
                                {
                                    id: 'verified-1',
                                    store_transaction_id: 'store-1',
                                    is_sandbox: false,
                                },
                            ],
                        },
                    },
                },
            }),
        },
    });
    const api = await withAPI(t, purchases);
    const added = await api('/api/credits/add', {
        code,
        credits: 999999,
        transactionId: 'synthetic-' + Date.now(),
    });
    assert.equal(added.status, 200);
    assert.equal(added.body.creditsAdded, 100);
    const again = await api('/api/credits/add', {
        code,
        credits: 999999,
        transactionId: 'another-fake',
    });
    assert.equal(again.body.creditsAdded, 0);
    assert.equal(again.body.newBalance, 100);
});

test('unavailable purchase verification never trusts the client or grants paid credits', async (t) => {
    const { recoveryCode: code } = await register();
    const purchases = createPurchases({ credits, axios: {}, apiKey: '' });
    const api = await withAPI(t, purchases);
    const result = await api('/api/credits/add', {
        code,
        credits: 100,
        transactionId: 'fake',
    });
    assert.equal(result.status, 503);
    assert.equal((await credits.balance(code)).credits, 0);
    assert.equal((await api('/api/credits/balance/' + code)).body.freeCreditsRemaining, 7);
});

test('unknown, refunded, sandbox, and malformed verified purchases are not granted', async () => {
    const { recoveryCode: code } = await register();
    const purchases = createPurchases({
        credits,
        apiKey: 'test',
        axios: {
            get: async () => ({
                data: {
                    subscriber: {
                        non_subscriptions: {
                            unknown_product: [{ id: 'unknown' }],
                            ai_notes_lite_pack_credits: [
                                null,
                                { id: 'refunded', refunded_at: '2026-11-11' },
                                { id: 'sandbox', is_sandbox: true },
                                {},
                            ],
                        },
                    },
                },
            }),
        },
    });
    assert.equal((await purchases.sync({ recoveryCode: code })).credits, 0);
});

test('webhooks require a configured secret and never grant for TEST events', async (t) => {
    const { recoveryCode: code } = await register();
    const api = await withAPI(t);
    const event = {
        type: 'TEST',
        product_id: 'ai_notes_lite_pack_credits',
        app_user_id: code,
        transaction_id: 'fake',
    };
    assert.equal((await api('/api/webhooks/revenuecat', { event })).status, 401);
    assert.equal(
        (await api('/api/webhooks/revenuecat', { event }, 'Bearer your_secret_here')).status,
        401,
    );
    assert.equal(
        (await api('/api/webhooks/revenuecat', { event }, 'Bearer test-hook-secret')).status,
        200,
    );
    assert.equal((await credits.balance(code)).credits, 0);
    const unconfigured = await withAPI(t, undefined, '');
    assert.equal(
        (await unconfigured('/api/webhooks/revenuecat', { event }, 'your_secret_here')).status,
        503,
    );
});

test('verified sync and duplicate webhooks share transaction aliases and grant once', async (t) => {
    const { recoveryCode: code } = await register();
    const date = '2026-11-11T09:00:00.000Z';
    const purchases = createPurchases({
        credits,
        apiKey: 'test',
        axios: {
            get: async () => ({
                data: {
                    subscriber: {
                        non_subscriptions: {
                            ai_notes_lite_pack_credits: [
                                {
                                    id: 'rc-1',
                                    store_transaction_id: 'store-1',
                                    purchase_date: date,
                                },
                            ],
                        },
                    },
                },
            }),
        },
    });
    const api = await withAPI(t, purchases);
    const event = {
        type: 'NON_RENEWING_PURCHASE',
        product_id: 'ai_notes_lite_pack_credits',
        app_user_id: code,
        transaction_id: 'store-1',
        id: 'event-1',
        purchased_at_ms: Date.parse(date),
        environment: 'PRODUCTION',
    };
    await Promise.all([
        ...Array.from({ length: 6 }, () =>
            api('/api/webhooks/revenuecat', { event }, 'test-hook-secret'),
        ),
        ...Array.from({ length: 6 }, () =>
            api('/api/credits/add', {
                code,
                credits: 9000,
                transactionId: 'fake',
            }),
        ),
    ]);
    assert.equal((await credits.balance(code)).credits, 100);
});

test('legacy credited purchase learns store aliases without another grant', async (t) => {
    const { recoveryCode: code } = await register();
    await User.updateOne(
        { recoveryCode: code },
        {
            $set: { credits: 100 },
            $push: {
                processedTransactions: {
                    transactionId: 'old-rc-id',
                    credits: 100,
                },
            },
        },
    );
    const purchases = createPurchases({
        credits,
        apiKey: 'test',
        axios: {
            get: async () => ({
                data: {
                    subscriber: {
                        non_subscriptions: {
                            ai_notes_lite_pack_credits: [
                                {
                                    id: 'old-rc-id',
                                    store_transaction_id: 'old-store-id',
                                },
                            ],
                        },
                    },
                },
            }),
        },
    });
    const api = await withAPI(t, purchases);
    const webhook = await api(
        '/api/webhooks/revenuecat',
        {
            event: {
                type: 'NON_RENEWING_PURCHASE',
                product_id: 'ai_notes_lite_pack_credits',
                app_user_id: code,
                transaction_id: 'old-store-id',
            },
        },
        'test-hook-secret',
    );
    assert.equal(webhook.status, 200);
    assert.equal(
        (await credits.grantPurchase(code, ['old-store-id'], 100, 'webhook')).applied,
        false,
    );
    assert.equal((await credits.balance(code)).credits, 100);
});

test('credit totals outside the safe integer range require review', async () => {
    await User.create({
        recoveryCode: 'OVERFLOW',
        credits: Number.MAX_SAFE_INTEGER,
        totalFreeCredits: 7,
        welcomePackVersion: 1,
    });
    await rejectsStatus(credits.balance('OVERFLOW'), 503);
});

test('pending purchases require admin authorization and link idempotently', async (t) => {
    const { recoveryCode: code } = await register();
    const api = await withAPI(t);
    const event = {
        type: 'NON_RENEWING_PURCHASE',
        product_id: 'ai_notes_lite_pack_credits',
        app_user_id: '$RCAnonymousID:unknown',
        transaction_id: 'pending-1',
    };
    await Promise.all(
        Array.from({ length: 5 }, () =>
            api('/api/webhooks/revenuecat', { event }, 'test-hook-secret'),
        ),
    );
    assert.equal(await PendingPurchase.countDocuments(), 1);
    assert.equal((await api('/api/admin/pending-purchases')).status, 401);
    assert.equal(
        (
            await api('/api/admin/link-purchase', {
                rcAppUserId: event.app_user_id,
                recoveryCode: code,
            })
        ).status,
        401,
    );
    await Promise.all(
        Array.from({ length: 4 }, () =>
            api(
                '/api/admin/link-purchase',
                { rcAppUserId: event.app_user_id, recoveryCode: code },
                'Bearer test-admin-secret',
            ),
        ),
    );
    assert.equal((await credits.balance(code)).credits, 100);
    assert.equal((await PendingPurchase.findOne()).status, 'processed');
});

test('changing the configured welcome grant affects new accounts without refilling existing users', async () => {
    config.welcomePackCredits = 11;
    const first = await register('configured-first');
    assert.equal(first.freeCreditsRemaining, 11);
    assert.equal(first.welcomePackCredits, 11);
    await credits.use(first.recoveryCode, 4);
    config.welcomePackCredits = 20;
    const second = await register('configured-second');
    assert.equal(second.freeCreditsRemaining, 20);
    const existing = await credits.balance(first.recoveryCode);
    assert.equal(existing.freeCreditsRemaining, 7);
    assert.equal(existing.welcomePackCredits, 20);
    config.welcomePackCredits = 2;
    assert.equal((await credits.balance(second.recoveryCode)).freeCreditsRemaining, 20);
    assert.equal((await register('configured-third')).freeCreditsRemaining, 2);
});

test('a zero welcome allowance is claimed once and is not granted later when the policy increases', async () => {
    config.welcomePackCredits = 0;
    const first = await register('zero-grant');
    assert.equal(first.totalAvailable, 0);
    const stored = await User.findOne({ recoveryCode: first.recoveryCode });
    assert.ok(stored.welcomeGrantClaimedAt);
    config.welcomePackCredits = 12;
    assert.equal((await register('zero-grant')).totalAvailable, 0);
    assert.equal((await register('new-grant')).freeCreditsRemaining, 12);
});

test('legacy configuration without a welcome amount uses the seven-credit default', async () => {
    delete config.welcomePackCredits;
    assert.equal((await register()).freeCreditsRemaining, 7);
});

test('invalid database welcome amounts fail before registering or granting credits', async () => {
    for (const amount of [-1, 1.5, '12', null, 10001, NaN, Infinity]) {
        config.welcomePackCredits = amount;
        await rejectsStatus(register('bad-policy'), 503);
    }
    assert.equal(await User.countDocuments(), 0);
});

test('concurrent requests grant the configured amount once for one device', async () => {
    config.welcomePackCredits = 13;
    const accounts = await Promise.all(
        Array.from({ length: 24 }, () => register('one-configured-grant')),
    );
    assert.equal(new Set(accounts.map((account) => account.recoveryCode)).size, 1);
    assert.ok(accounts.every((account) => account.freeCreditsRemaining === 13));
    assert.equal(await User.countDocuments(), 1);
});

test('the config schema accepts zero and rejects fractional or out-of-range welcome amounts', async () => {
    assert.equal(new AppConfig({ welcomePackCredits: 0 }).validateSync(), undefined);
    for (const amount of [-1, 2.5, 10001])
        assert.ok(new AppConfig({ welcomePackCredits: amount }).validateSync());
});


test('restored receipt keeps old packs with their owner and syncs a new Mac pack once', async () => {
    const { recoveryCode: first } = await register('first-mac-account');
    const { recoveryCode: second } = await register('second-mac-account');
    await credits.grantPurchase(first, ['old-apple-store'], 100, 'test');
    const purchases = createPurchases({ credits, apiKey: 'test', axios: { get: async () => ({ data: {
        subscriber: { non_subscriptions: { ai_notes_lite_pack_credits: [
            { store_transaction_id: 'old-apple-store' },
            { store_transaction_id: 'new-mac-store' },
        ] } },
    } }) } });
    const user = await User.findOne({ recoveryCode: second }).lean();
    assert.equal((await purchases.sync(user, { required: true })).credits, 100);
    assert.equal((await purchases.sync(user, { required: true })).credits, 0);
    assert.equal((await credits.balance(first)).credits, 100);
    assert.equal((await credits.balance(second)).credits, 100);
    await assert.rejects(credits.grantPurchase(second, ['old-apple-store'], 100, 'test'),
        error => error.status === 409 && error.details.code === 'PURCHASE_OWNED_BY_ANOTHER_ACCOUNT');
});

test('master allowance is a grant template: spending on one user never changes another or the configured seven', async () => {
    const first = await register('isolation-first');
    const second = await register('isolation-second');
    assert.notEqual(first.recoveryCode, second.recoveryCode);
    assert.equal(first.freeCreditsRemaining, 7);
    assert.equal(second.freeCreditsRemaining, 7);
    await credits.use(first.recoveryCode, 1);
    assert.equal((await credits.balance(first.recoveryCode)).freeCreditsRemaining, 6);
    assert.equal((await credits.balance(second.recoveryCode)).freeCreditsRemaining, 7);
    assert.equal((await User.findOne({ recoveryCode: first.recoveryCode })).totalFreeCredits, 6);
    assert.equal((await User.findOne({ recoveryCode: second.recoveryCode })).totalFreeCredits, 7);
    assert.equal(config.welcomePackCredits, 7);
    await credits.use(second.recoveryCode, 2);
    assert.equal((await credits.balance(first.recoveryCode)).freeCreditsRemaining, 6);
    assert.equal((await credits.balance(second.recoveryCode)).freeCreditsRemaining, 5);
    assert.equal(config.welcomePackCredits, 7);
});

test('an untouched legacy user migrates on first balance read, with a persisted personal grant', async () => {
    await User.create({ recoveryCode: 'LEGACYUNTOUCHED', credits: 12,
        freeCreditsRemaining: 3, totalFreeCredits: 0, welcomePackVersion: 0 });
    const before = await User.findOne({ recoveryCode: 'LEGACYUNTOUCHED' });
    assert.equal(before.totalFreeCredits, 0);
    const result = await credits.balance('LEGACYUNTOUCHED');
    assert.equal(result.freeCreditsRemaining, 7);
    assert.equal(result.totalAvailable, 19);
    const after = await User.findOne({ recoveryCode: 'LEGACYUNTOUCHED' });
    assert.equal(after.totalFreeCredits, 7);
    assert.ok(after.welcomeGrantClaimedAt);
    assert.equal(after.credits, 12);
    assert.equal(after.freeCreditsRemaining, 3, 'old daily field is preserved but not spent in one-time mode');
    await credits.use('LEGACYUNTOUCHED', 1);
    assert.equal((await credits.balance('LEGACYUNTOUCHED')).freeCreditsRemaining, 6);
    assert.equal((await User.findOne({ recoveryCode: 'LEGACYUNTOUCHED' })).totalFreeCredits, 6);
});

test('pack confirmation waits for the specific store transaction and acknowledges duplicates', async t => {
    const { recoveryCode: code } = await register();
    const entries = [];
    const purchases = createPurchases({ credits, apiKey: 'test', axios: {
        get: async () => ({ data: { subscriber: { non_subscriptions: {
            ai_notes_lite_pack_credits: entries,
        } } } }),
    } });
    const api = await withAPI(t, purchases);
    const purchase = { productId: 'ai_notes_lite_pack_credits', transactionId: 'store-pack-test' };
    const pending = await api('/api/credits/add', { code, purchase });
    assert.equal(pending.body.purchase.status, 'pending');
    entries.push({ store_transaction_id: 'store-pack-test', is_sandbox: false });
    const applied = await api('/api/credits/add', { code, purchase });
    assert.equal(applied.body.purchase.status, 'credited');
    assert.equal(applied.body.purchase.credits, 100);
    assert.equal(applied.body.newBalance, 100);
    const duplicate = await api('/api/credits/add', { code, purchase });
    assert.equal(duplicate.body.purchase.status, 'credited');
    assert.equal(duplicate.body.purchase.alreadyProcessed, true);
    assert.equal(duplicate.body.newBalance, 100);
});

test('sandbox pack acknowledgement reports the server policy and permits an isolated test grant', async () => {
    const { recoveryCode: code } = await register();
    const user = await User.findOne({ recoveryCode: code }).lean();
    const purchase = { productId: 'ai_notes_lite_pack_credits', transactionId: 'sandbox-pack-test' };
    const options = { credits, apiKey: 'test', axios: {
        get: async () => ({ data: { subscriber: { non_subscriptions: {
            [purchase.productId]: [{ store_transaction_id: purchase.transactionId, is_sandbox: true }],
        } } } }),
    } };
    const blocked = await createPurchases(options).sync(user, { purchase });
    assert.equal(blocked.purchase.status, 'sandbox_disabled');
    assert.equal((await credits.balance(code)).credits, 0);
    const allowed = await createPurchases({ ...options, allowSandbox: true }).sync(user, { purchase });
    assert.equal(allowed.purchase.status, 'credited');
    assert.equal(allowed.purchase.sandbox, true);
    assert.equal((await credits.balance(code)).credits, 100);
});

test('verified Apple sandbox packs grant once via balance sync and webhook without an environment switch', async t => {
    const { recoveryCode: code } = await register();
    const product = 'ai_notes_lite_pack_credits';
    const purchases = createPurchases({ credits, apiKey: 'test', axios: {
        get: async () => ({ data: { subscriber: { non_subscriptions: {
            [product]: [{ store_transaction_id: 'apple-sandbox-topup', is_sandbox: true, store: 'app_store' }],
        } } } }),
    } });
    const api = await withAPI(t, purchases);
    const purchase = { productId: product, transactionId: 'apple-sandbox-topup' };
    const applied = await api('/api/credits/add', { code, purchase });
    assert.equal(applied.body.purchase.status, 'credited');
    assert.equal(applied.body.newBalance, 100);
    const duplicate = await api('/api/credits/add', { code, purchase });
    assert.equal(duplicate.body.newBalance, 100);
    const event = { type: 'NON_RENEWING_PURCHASE', environment: 'SANDBOX', store: 'APP_STORE',
        app_user_id: code, product_id: product, transaction_id: 'apple-sandbox-topup' };
    await api('/api/webhooks/revenuecat', { event }, 'Bearer test-hook-secret');
    assert.equal((await credits.balance(code)).credits, 100);
    event.transaction_id = 'second-apple-sandbox-pack';
    await api('/api/webhooks/revenuecat', { event }, 'Bearer test-hook-secret');
    await api('/api/webhooks/revenuecat', { event }, 'Bearer test-hook-secret');
    assert.equal((await credits.balance(code)).credits, 200);
});

test('signed Apple credit grant survives repeat verification and matches later RevenueCat sync', async t => {
    const { recoveryCode: code } = await register();
    const purchase = { productId: 'ai_notes_lite_pack_credits', transactionId: '1234500001' };
    const date = Date.now() - 10000;
    const payload = { bundleId: 'com.taptapcreate.ainotes', type: 'Consumable',
        environment: 'Sandbox', productId: purchase.productId, transactionId: purchase.transactionId, purchaseDate: date };
    const options = { credits, apiKey: 'test', verifyApple: async signed => {
        assert.equal(signed, 'verified-signed-transaction'); return payload;
    }, axios: { get: async () => ({ data: { subscriber: { non_subscriptions: {
        [purchase.productId]: [{ id: 'revenuecat-alias', store: 'app_store', is_sandbox: true, purchase_date: new Date(date).toISOString() }],
    } } } }) } };
    const purchases = createPurchases(options);
    const api = await withAPI(t, purchases);
    const body = { code, purchase, signedAppleTransaction: 'verified-signed-transaction' };
    const first = await api('/api/credits/add', body);
    assert.equal(first.body.purchase.status, 'credited');
    assert.equal(first.body.newBalance, 100);
    // Simulate the client losing the response and replaying after relaunch.
    const replay = await api('/api/credits/add', body);
    assert.equal(replay.body.purchase.alreadyProcessed, true);
    assert.equal(replay.body.newBalance, 100);
    await purchases.sync(await User.findOne({ recoveryCode: code }).lean());
    assert.equal((await credits.balance(code)).credits, 100);
    const mismatch = await api('/api/credits/add', { ...body, purchase: { ...purchase, transactionId: '999999999' } });
    assert.equal(mismatch.status, 400);
    payload.revocationDate = Date.now();
    assert.equal((await api('/api/credits/add', body)).status, 400);
});
