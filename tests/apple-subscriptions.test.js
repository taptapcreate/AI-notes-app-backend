const AccountRecovery = require('../models/AccountRecovery');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const User = require('../models/User');
const Subscription = require('../models/AppleSubscription');
const GenerationRequest = require('../models/GenerationRequest');
const CreditRegistration = require('../models/CreditRegistration');
const PurchaseClaim = require('../models/PurchaseClaim');
const {
    createAppleSubscriptions,
    appleVerifier,
    identity,
} = require('../services/apple-subscriptions');
const { createCredits } = require('../services/credits');
const { createGeneration } = require('../services/generation');
const { createPurchases } = require('../services/purchases');
const LedgerAccount = require('../models/SubscriptionCreditAccount');
const LedgerAllocation = require('../models/SubscriptionCreditAllocation');
const LedgerEntry = require('../models/SubscriptionCreditLedgerEntry');
let mongo, service, credits, generation, time, config;
const codes = ['MACCODEA', 'IPADCODE'];
const source = { type: 'text', content: 'Explain event loop' };
const proof = (fields = {}) => ({
    originalTransactionId: '100000000001',
    transactionId: '100000000002',
    productId: 'ai_notes_pro_monthly_subscription',
    bundleId: 'com.taptapcreate.ainotes',
    environment: 'Sandbox',
    purchaseDate: time.getTime() - 10000,
    signedDate: time.getTime(),
    expiresDate: time.getTime() + 3600000,
    ...fields,
});
before(async () => {
    mongo = await MongoMemoryReplSet.create({
        binary: { version: '8.0.17' },
        replSet: { count: 1 },
    });
    await mongoose.connect(mongo.getUri(), { dbName: 'shared_subscriptions' });
    await Promise.all(
        [
            User,
            Subscription,
            GenerationRequest,
            CreditRegistration,
            PurchaseClaim,
            LedgerAccount, LedgerAllocation, LedgerEntry,
        ].map((model) => model.init()),
    );
});
after(async () => {
    await mongoose.disconnect();
    await mongo?.stop();
});
beforeEach(async () => {
    await AccountRecovery.deleteMany({});
    await Promise.all(
        [
            User,
            Subscription,
            GenerationRequest,
            CreditRegistration,
            PurchaseClaim,
            LedgerAccount, LedgerAllocation, LedgerEntry,
        ].map((model) => model.deleteMany({})),
    );
    time = new Date('2026-11-13T00:00:00Z');
    config = {
        dailyFreeCreditsEnabled: false,
        welcomePackCredits: 7,
        subscriberDailyLimit: 10,
        dailySubscriptionAllowanceEnabled: true,
    };
    service = createAppleSubscriptions({
        User,
        Subscription,
        GenerationRequest,
        getAppConfig: async () => config,
        now: () => new Date(time),
        verify: async (encoded) => {
            if (encoded === 'INVALID') throw Error('Invalid signature');
            return JSON.parse(encoded);
        },
    });
    credits = createCredits({
        User,
        CreditRegistration,
        PurchaseClaim,
        getAppConfig: async () => config,
        now: () => new Date(time),
        subscriptionUsageFor: service.usage,
    });
    generation = createGeneration({
        User,
        Subscription,
        GenerationRequest,
        credits,
        getAppConfig: async () => config,
        entitlement: service.status,
        resolveStoreKitScope: service.resolveStoreKitScope,
        now: () => new Date(time),
    });
    await User.create(
        codes.map((recoveryCode, index) => ({
            recoveryCode,
            credits: 20 + index,
            totalFreeCredits: 7,
            welcomePackVersion: 1,
            welcomeGrantClaimedAt: time,
            lastRequestReset: time,
        })),
    );
});
const attach = async (code, fields = {}) =>
    service.attach(code, [JSON.stringify(proof(fields))]);
const status = async (code) =>
    service.status(await User.findOne({ recoveryCode: code }).lean());
test('subscription timing records real local query durations without recording test account data', async () => {
    const { EventEmitter } = require('node:events');
    const { subscriptionTimingMiddleware } = require('../services/subscription-timing');
    const logs = [];
    const res = new EventEmitter();
    res.statusCode = 200;
    const middleware = subscriptionTimingMiddleware({ logger: {
        info: (label, timing) => logs.push({ label, timing }),
    } });
    await middleware({ method: 'POST', path: '/credits/apple-subscription' }, res, async () => {
        await attach(codes[0]);
        assert.equal((await status(codes[0])).isPro, true);
    });
    res.emit('finish');
    assert.equal(logs.length, 1);
    const spans = logs[0].timing.spans;
    for (const operation of ['subscription_transaction', 'db.wallet.findOne', 'db.subscription.find']) {
        assert.ok(spans.some(span => span.operation === operation && span.outcome === 'ok'), operation);
    }
    assert.ok(spans.every(span => Number.isFinite(span.durationMs) && span.durationMs >= 0));
    const serialized = JSON.stringify(logs);
    for (const privateValue of [...codes, proof().originalTransactionId, proof().transactionId]) {
        assert.equal(serialized.includes(privateValue), false);
    }
});
test('the same Apple subscription links two different wallets without transferring access or balances', async () => {
    await attach(codes[0]);
    await attach(codes[1]);
    const a = await status(codes[0]),
        b = await status(codes[1]);
    assert.equal(a.isPro, true);
    assert.equal(b.isPro, true);
    assert.equal(a.quotaId, b.quotaId);
    assert.equal(await Subscription.countDocuments(), 1);
    assert.equal((await credits.balance(codes[0])).credits, 20);
    assert.equal((await credits.balance(codes[1])).credits, 21);
    let providerCalls = 0;
    const purchases = createPurchases({
        credits,
        apiKey: 'test',
        axios: {
            get: async () => {
                providerCalls++;
                return {
                    data: {
                        subscriber: { entitlements: {}, subscriptions: {} },
                    },
                };
            },
        },
        appleSubscriptions: service,
    });
    assert.equal(
        (await purchases.subscriptionStatus(await credits.byCode(codes[0])))
            .isPro,
        true,
    );
    assert.equal(
        providerCalls,
        0,
        'empty RevenueCat customer after transfer must not revoke shared Apple Pro',
    );
});
test('parallel requests on different devices reserve a single shared quota and leave free/purchased credits untouched', async () => {
    await Promise.all(codes.map((code) => attach(code)));
    config.subscriberDailyLimit = 2;
    const requests = await Promise.allSettled(
        [codes[0], codes[1], codes[0], codes[1]].map((code) =>
            generation.begin(code, randomUUID(), '/notes', source),
        ),
    );
    assert.equal(
        requests.filter((value) => value.status === 'fulfilled').length,
        2,
    );
    const rejected = requests.filter((value) => value.status === 'rejected');
    assert.equal(rejected.length, 2);
    assert.ok(rejected.every((value) => value.reason.status === 429));
    assert.equal((await credits.balance(codes[0])).subscriberDailyRemaining, 0);
    assert.equal((await credits.balance(codes[1])).subscriberDailyRemaining, 0);
    assert.equal((await credits.balance(codes[0])).credits, 20);
    assert.equal((await credits.balance(codes[0])).freeCreditsRemaining, 7);
});
test('failed generations refund the shared reservation once, including when another wallet links while it is running', async () => {
    await attach(codes[0]);
    const begun = await generation.begin(
        codes[0],
        randomUUID(),
        '/notes',
        source,
    );
    time = new Date(time.getTime() + 30000);
    await attach(codes[1]);
    await generation.finish(begun.record._id, 500, { error: 'AI unavailable' });
    await generation.finish(begun.record._id, 500, { error: 'AI unavailable' });
    assert.equal(
        (await credits.balance(codes[1])).subscriberDailyRemaining,
        10,
    );
    assert.equal((await Subscription.findOne()).dailyRequestCount, 0);
});
test('midnight reset and global/custom limits apply to both devices and restores never replenish usage', async () => {
    await attach(codes[0]);
    await attach(codes[1]);
    await generation.begin(codes[0], randomUUID(), '/notes', source);
    await attach(codes[0]);
    await attach(codes[1]);
    assert.equal((await credits.balance(codes[1])).subscriberDailyRemaining, 9);
    config.subscriberDailyLimit = 15;
    assert.equal(
        (await credits.balance(codes[0])).subscriberDailyRemaining,
        14,
    );
    await Subscription.updateOne(
        {},
        { $set: { subscriberDailyLimitOverride: 20 } },
    );
    assert.equal(
        (await credits.balance(codes[1])).subscriberDailyRemaining,
        19,
    );
    time = new Date('2026-11-14T00:00:00Z');
    assert.equal(
        (await credits.balance(codes[0])).subscriberDailyRemaining,
        20,
    );
    assert.equal(
        (await status(codes[1])).isPro,
        false,
        'expiry is checked on the server clock',
    );
});
test('existing per-wallet usage migrates once, sums usage across wallets and is preserved after renewals', async () => {
    await User.updateOne(
        { recoveryCode: codes[0] },
        { $set: { dailyRequestCount: 2 } },
    );
    await User.updateOne(
        { recoveryCode: codes[1] },
        { $set: { dailyRequestCount: 3 } },
    );
    await attach(codes[0]);
    await attach(codes[1]);
    await attach(codes[0]);
    assert.equal((await credits.balance(codes[0])).subscriberDailyRemaining, 5);
    await attach(codes[1], {
        transactionId: '100000000003',
        purchaseDate: time.getTime(),
        expiresDate: time.getTime() + 7200000,
        signedDate: time.getTime() + 1000,
    });
    assert.equal((await credits.balance(codes[1])).subscriberDailyRemaining, 5);
});
test('revocation is shared, voluntary cancellation keeps access to expiry, and old signed proof cannot undo a refund', async () => {
    const original = proof();
    await attach(codes[0]);
    await attach(codes[1]);
    const event = {
        product_id: original.productId,
        store: 'APP_STORE',
        environment: 'SANDBOX',
        original_transaction_id: original.originalTransactionId,
        transaction_id: original.transactionId,
        event_timestamp_ms: time.getTime(),
        expiration_at_ms: original.expiresDate,
    };
    await service.webhook({
        ...event,
        type: 'CANCELLATION',
        cancel_reason: 'UNSUBSCRIBE',
    });
    assert.equal((await status(codes[0])).isPro, true);
    time = new Date(time.getTime() + 1000);
    await service.webhook({
        ...event,
        event_timestamp_ms: time.getTime(),
        expiration_at_ms: time.getTime(),
        type: 'CANCELLATION',
        cancel_reason: 'CUSTOMER_SUPPORT',
    });
    assert.equal((await status(codes[0])).isPro, false);
    assert.equal((await status(codes[1])).isPro, false);
    await service.attach(codes[0], [JSON.stringify(original)]);
    assert.equal((await status(codes[0])).isPro, false);
});
test('invalid proofs and unrelated apps/products never link wallets; Apple sandbox and production stay separate', async () => {
    await assert.rejects(() => service.attach(codes[0], ['INVALID']));
    await assert.rejects(() => attach(codes[0], { bundleId: 'other.app' }));
    await assert.rejects(() => attach(codes[0], { productId: 'credit_pack' }));
    assert.equal(
        (await User.findOne({ recoveryCode: codes[0] })).appleSubscriptionIds
            .length,
        0,
    );
    await attach(codes[0]);
    await attach(codes[1], { environment: 'Production' });
    assert.notEqual(
        (await status(codes[0])).quotaId,
        (await status(codes[1])).quotaId,
    );
    assert.notEqual(identity('Sandbox', '100'), identity('Production', '100'));
    const verify = appleVerifier();
    const forged =
        Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url') +
        '.' +
        Buffer.from(JSON.stringify(proof())).toString('base64url') +
        '.invalid';
    await assert.rejects(() => verify(forged), /verify/);
});

test('expired shared Pro still allows separate lifetime or purchased credits', async () => {
    await attach(codes[0]);
    time = new Date(time.getTime() + 7200000);
    const begun = await generation.begin(
        codes[0],
        randomUUID(),
        '/notes',
        source,
    );
    assert.equal(begun.record.reservation.pro, false);
    assert.equal((await credits.balance(codes[0])).freeCreditsRemaining, 6);
    assert.equal((await credits.balance(codes[0])).credits, 20);
});
test('explicit paid fallback spends only the requesting wallet after the shared allowance is exhausted', async () => {
    await attach(codes[0]);
    await attach(codes[1]);
    config.subscriberDailyLimit = 1;
    await generation.begin(codes[0], randomUUID(), '/notes', source);
    const bought = await generation.begin(codes[1], randomUUID(), '/notes', {
        ...source,
        billingMode: 'purchased',
    });
    assert.equal(bought.record.reservation.pro, false);
    assert.equal((await credits.balance(codes[1])).credits, 20);
    assert.equal((await credits.balance(codes[0])).credits, 20);
    assert.equal((await credits.balance(codes[1])).freeCreditsRemaining, 7);
});

test('expiration events win over old signed proof and an unbound expired proof does not replace a wallet membership', async () => {
    const initial = proof();
    await attach(codes[0]);
    time = new Date(time.getTime() + 2000);
    await service.webhook({
        type: 'EXPIRATION',
        product_id: initial.productId,
        store: 'APP_STORE',
        environment: 'SANDBOX',
        original_transaction_id: initial.originalTransactionId,
        transaction_id: initial.transactionId,
        event_timestamp_ms: time.getTime(),
        expiration_at_ms: time.getTime(),
    });
    await service.attach(codes[0], [JSON.stringify(initial)]);
    await service.attach(codes[1], [JSON.stringify(initial)]);
    assert.equal((await status(codes[0])).isPro, false);
    assert.equal(await status(codes[1]), null);
});

test('a pending request started before linking refunds the migrated shared quota', async () => {
    const legacy = createGeneration({
        User,
        GenerationRequest,
        credits,
        getAppConfig: async () => config,
        entitlement: async () => ({ isPro: true }),
        now: () => new Date(time),
    });
    const begun = await legacy.begin(codes[0], randomUUID(), '/notes', source);
    await attach(codes[0]);
    await attach(codes[1]);
    assert.equal((await credits.balance(codes[1])).subscriberDailyRemaining, 9);
    await generation.finish(begun.record._id, 500, { error: 'AI unavailable' });
    assert.equal(
        (await credits.balance(codes[1])).subscriberDailyRemaining,
        10,
    );
});

test('exhausted shared Pro and free credits can use an explicitly approved purchased credit', async () => {
    await attach(codes[0]);
    const membership = await service.status(await User.findOne({ recoveryCode: codes[0] }).lean());
    await Subscription.updateOne({ _id: membership.quotaId }, {
        $set: { dailyRequestCount: 10, lastRequestReset: time },
    });
    await User.updateOne({ recoveryCode: codes[0] }, { $set: { totalFreeCredits: 0, credits: 10 } });
    // A provider response obtained before the shared link completed lacks quotaId.
    const stale = createGeneration({
        User, Subscription, GenerationRequest, credits,
        getAppConfig: async () => config,
        entitlement: async () => ({ isPro: true }),
        now: () => new Date(time),
    });
    await assert.rejects(stale.begin(codes[0], randomUUID(), '/notes', source),
        error => error.status === 429 && error.details.code === 'SUBSCRIPTION_DAILY_LIMIT' &&
            error.details.purchasedCreditsAvailable === 10);
    const id = randomUUID();
    const body = { ...source, billingMode: 'purchased' };
    const { record } = await stale.begin(codes[0], id, '/notes', body);
    assert.equal(record.reservation.pro, false);
    assert.equal(record.reservation.paid, 1);
    assert.equal(record.reservation.free, 0);
    assert.equal((await credits.balance(codes[0])).credits, 9);
    assert.equal((await Subscription.findById(membership.quotaId)).dailyRequestCount, 10);
    await stale.finish(record._id, 200, { notes: 'Paid result' });
    assert.equal((await stale.begin(codes[0], id, '/notes', body)).cached, true);
    assert.equal((await credits.balance(codes[0])).credits, 9);
});

test('an Apple subscription expiring after status lookup still permits approved purchased credits', async () => {
    await attach(codes[0]);
    const membership = await service.status(await User.findOne({ recoveryCode: codes[0] }).lean());
    await Subscription.updateOne({ _id: membership.quotaId }, {
        $set: { expiresAt: new Date(time.getTime() - 1000) },
    });
    const stale = createGeneration({
        User, Subscription, GenerationRequest, credits,
        getAppConfig: async () => config,
        entitlement: async () => membership,
        now: () => new Date(time),
    });
    const { record } = await stale.begin(codes[0], randomUUID(), '/notes',
        { ...source, billingMode: 'purchased' });
    assert.equal(record.reservation.pro, false);
    assert.equal(record.reservation.membershipPro, false);
    assert.equal(record.reservation.paid, 1);
    assert.equal(record.reservation.free, 0);
    assert.equal((await credits.balance(codes[0])).credits, 19);
    assert.equal((await credits.balance(codes[0])).freeCreditsRemaining, 7);
});

test('the same wallet uses only the current sandbox tester’s verified allowance', async () => {
    const code = codes[0];
    const testerA = JSON.stringify(proof());
    await service.attach(code, [testerA]);
    const a = await status(code);
    await Subscription.updateOne({ _id: a.quotaId }, {
        $set: { dailyRequestCount: 10, lastRequestReset: time },
    });

    const noProofs = await service.resolveStoreKitScope([]);
    const wallet = await credits.byCode(code);
    assert.equal((await service.status(wallet, noProofs)).isPro, false);
    const free = await generation.begin(code, randomUUID(), '/notes', source, []);
    assert.equal(free.record.reservation.membershipPro, false);
    assert.equal(free.record.reservation.free, 1);

    const testerB = JSON.stringify(proof({
        originalTransactionId: '200000000001',
        transactionId: '200000000002',
        expiresDate: time.getTime() + 1600000,
    }));
    await service.attach(code, [testerB]);
    const scopeB = await service.resolveStoreKitScope([testerB]);
    assert.equal((await service.status(await credits.byCode(code), scopeB)).quotaId, scopeB[0]);
    assert.equal((await credits.balance(code, scopeB)).subscriberDailyRemaining, 10);
    const paidByB = await generation.begin(code, randomUUID(), '/notes', source, [testerB]);
    assert.equal(paidByB.record.reservation.subscriptionId, scopeB[0]);
    assert.equal((await credits.balance(code, scopeB)).subscriberDailyRemaining, 9);
    assert.equal((await credits.balance(code, [a.quotaId])).subscriberDailyRemaining, 0);
});

test('a StoreKit sandbox scope preserves the linked production subscription and its own usage', async () => {
    const code = codes[0];
    await attach(code);
    const sandbox = await status(code);
    await Subscription.updateOne({ _id: sandbox.quotaId }, {
        $set: { dailyRequestCount: 10, lastRequestReset: time },
    });
    await attach(code, { environment: 'Production', expiresDate: time.getTime() + 1800000 });
    const production = await service.status(await credits.byCode(code), []);
    assert.equal(production.isPro, true);
    assert.notEqual(production.quotaId, sandbox.quotaId);
    assert.equal((await credits.balance(code, [])).subscriberDailyRemaining, 10);
    const begun = await generation.begin(code, randomUUID(), '/notes', source, []);
    assert.equal(begun.record.reservation.subscriptionId, production.quotaId);
});


test('restoring after collection deletion preserves a previously exhausted subscription allowance', async () => {
    const code = codes[0];
    await User.updateOne({ recoveryCode: code }, { $set: { dailyRequestCount: 10 } });
    await attach(code);
    const membership = await status(code);
    assert.equal((await credits.balance(code)).subscriberDailyRemaining, 0);
    await Subscription.collection.drop();
    assert.equal((await credits.balance(code)).subscriberDailyRemaining, 0);
    assert.equal((await attach(code)).subscriberDailyRemaining, 0);
    assert.equal((await status(code)).quotaId, membership.quotaId);
    const wallet = await credits.byCode(code);
    assert.equal(wallet.credits, 20);
    assert.equal(wallet.totalFreeCredits, 7);
});

test('verified StoreKit recovery preserves the quota epoch and refunds the original reservation', async () => {
    const code = codes[0];
    const payload = JSON.stringify(proof());
    await service.attach(code, [payload]);
    const before = await generation.begin(code, randomUUID(), '/notes', source, [payload]);
    await Subscription.deleteMany({});
    const after = await generation.begin(code, randomUUID(), '/notes', source, [payload]);
    assert.equal(after.record.reservation.subscriptionId, before.record.reservation.subscriptionId);
    assert.equal(after.record.reservation.quotaEpoch, before.record.reservation.quotaEpoch);
    await generation.finish(before.record._id, 500, { error: 'AI unavailable' });
    assert.equal((await credits.balance(code)).subscriberDailyRemaining, 9);
});

test('request-history fallback retains shared allowance across Apple record deletion', async () => {
    await Promise.all(codes.map(code => attach(code)));
    config.subscriberDailyLimit = 2;
    config.billingControls = { usePrimarySubscriptionTracking: false };
    const results = await Promise.allSettled([codes[0], codes[1], codes[0], codes[1]].map(code =>
        generation.begin(code, randomUUID(), '/notes', source)));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 2);
    assert.equal((await credits.balance(codes[0])).subscriberDailyRemaining, 0);
    assert.equal((await credits.balance(codes[1])).subscriberDailyRemaining, 0);
    await Subscription.deleteMany({});
    await attach(codes[0]);
    assert.equal((await credits.balance(codes[0])).subscriberDailyRemaining, 0);
});


test('missing Apple daily counter uses verified shared history without changing subscription identity', async () => {
    await Promise.all(codes.map(code => attach(code)));
    for (let i = 0; i < 3; i++) {
        const request = await generation.begin(codes[i % 2], randomUUID(), '/notes', source);
        await generation.finish(request.record._id, 200, { notes: 'Verified shared note' });
    }
    const membership = await status(codes[0]);
    const original = await Subscription.findById(membership.quotaId).lean();
    const paidBefore = (await credits.balance(codes[0])).totalAvailable;
    config.billingControls = { usePrimarySubscriptionTracking: false };
    await Subscription.updateOne({ _id: membership.quotaId }, { $unset: { dailyRequestCount: 1 } });
    for (const code of codes) {
        const usage = await credits.balance(code);
        assert.equal(usage.subscriptionTrackingSource, 'requestHistory');
        assert.equal(usage.subscriberDailyUsage, 3);
        assert.equal(usage.subscriberDailyRemaining, 7);
    }
    const next = await generation.begin(codes[1], randomUUID(), '/notes', source);
    await generation.finish(next.record._id, 200, { notes: 'Fourth shared note' });
    const repaired = await Subscription.findById(membership.quotaId).lean();
    assert.equal(repaired.quotaEpoch, original.quotaEpoch);
    assert.equal(repaired.dailyRequestCount, 4);
    for (const code of codes) assert.equal((await credits.balance(code)).subscriberDailyRemaining, 6);
    config.billingControls.usePrimarySubscriptionTracking = true;
    assert.equal((await credits.balance(codes[0])).subscriberDailyRemaining, 6);
    assert.equal((await credits.balance(codes[0])).totalAvailable, paidBefore);
});


test('deleting wallet and subscription together preserves their shared remaining allowance', async () => {
    await Promise.all(codes.map(code => attach(code)));
    const membership = await status(codes[0]);
    for (let i = 0; i < 3; i++) {
        const request = await generation.begin(codes[i % 2], randomUUID(), '/notes', source);
        await generation.finish(request.record._id, 200, { notes: 'Charged note' });
    }
    await credits.grantPurchase(codes[0], ['paid-order'], 10, 'store');
    const before = await credits.byCode(codes[0]);
    await User.deleteOne({ recoveryCode: codes[0] }); await Subscription.deleteMany({});
    const restored = await credits.balance(codes[0]);
    assert.equal(restored.subscriberDailyRemaining, 7);
    assert.equal(restored.credits, before.credits);
    assert.equal(restored.freeCreditsRemaining, before.totalFreeCredits);
    assert.equal((await status(codes[0])).quotaId, membership.quotaId);
    config.billingControls = { usePrimarySubscriptionTracking: false };
    assert.equal((await credits.balance(codes[1])).subscriberDailyRemaining, 7);
});
test('subscription expiration webhook recovers missing record without reviving entitlement', async () => {
    await attach(codes[0]); await Subscription.deleteMany({});
    await service.webhook({ product_id: 'ai_notes_pro_monthly_subscription', store: 'APP_STORE', environment: 'SANDBOX',
        original_transaction_id: '100000000001', transaction_id: '100000000002',
        event_timestamp_ms: time.getTime(), expiration_at_ms: time.getTime() - 1, type: 'EXPIRATION' });
    assert.equal((await status(codes[0])).isPro, false);
    await Subscription.deleteMany({});
    assert.equal((await status(codes[0])).isPro, false);
});

test('trial usage is shared across devices and only a verified paid period refills the allowance', async () => {
    config.dailySubscriptionAllowanceEnabled = false;
    const trial = proof({
        offerType: 1,
        offerDiscountType: 'FREE_TRIAL',
        expiresDate: time.getTime() + 3 * 86400000,
    });
    for (const code of codes) await service.attach(code, [JSON.stringify(trial)]);
    const day = 86400000;
    const use = async (code, result = 200) => {
        const { record } = await generation.begin(code, randomUUID(), '/notes', source);
        await generation.finish(record._id, result, result === 200 ? { notes: 'Note' } : { error: 'Failed' });
    };
    const remaining = async (code = codes[0]) => (await credits.balance(code)).subscriberDailyRemaining;
    assert.equal(await remaining(), 3);
    await use(codes[0]);
    time = new Date(time.getTime() + day);
    await use(codes[1]);
    await use(codes[1], 500);
    assert.equal(await remaining(), 1);
    assert.equal((await credits.balance(codes[1])).subscriberAllowancePeriod, 'trial');
    assert.equal(await remaining(codes[1]), 1);

    const event = {
        product_id: trial.productId, store: 'APP_STORE', environment: 'SANDBOX',
        original_transaction_id: trial.originalTransactionId, transaction_id: trial.transactionId,
        purchased_at_ms: trial.purchaseDate, expiration_at_ms: trial.expiresDate,
        event_timestamp_ms: time.getTime(), period_type: 'TRIAL',
    };
    await service.webhook({ ...event, type: 'CANCELLATION' });
    await service.attach(codes[0], [JSON.stringify({
        ...trial, offerType: undefined, offerDiscountType: undefined, signedDate: time.getTime(),
    })]);
    await service.webhook({ ...event, type: 'INITIAL_PURCHASE', period_type: 'NORMAL',
        event_timestamp_ms: time.getTime() + 1, purchased_at_ms: trial.purchaseDate - 1000 });
    assert.equal(await remaining(), 1);
    assert.equal((await status(codes[0])).isPro, true);
    await Subscription.deleteMany({});
    assert.equal(await remaining(), 1);
    config.billingControls = { usePrimarySubscriptionTracking: false };
    assert.equal(await remaining(), 1);

    time = new Date(trial.expiresDate + 1);
    await service.webhook({ ...event, type: 'EXPIRATION', event_timestamp_ms: time.getTime() });
    assert.equal((await status(codes[0])).isPro, false);
    assert.equal(await remaining(), 0);

    const renewal = {
        ...event, type: 'RENEWAL', period_type: 'NORMAL', is_trial_conversion: true,
        transaction_id: '100000000003',
        event_timestamp_ms: time.getTime() + 1,
        purchased_at_ms: time.getTime(), expiration_at_ms: time.getTime() + 30 * day,
    };
    assert.equal(await service.webhook(renewal), true);
    assert.equal(await remaining(), 600);
    await use(codes[1]);
    await service.webhook(renewal);
    await service.attach(codes[0], [JSON.stringify(trial)]);
    assert.equal(await remaining(), 599);
    const paid = await credits.balance(codes[0]);
    assert.equal(paid.subscriberAllowancePeriod, 'monthly');
    assert.equal(paid.subscriberResetAt, new Date(renewal.expiration_at_ms).toISOString());
    assert.equal(paid.credits, 20);
    assert.equal(paid.freeCreditsRemaining, 7);
    config.billingControls.usePrimarySubscriptionTracking = true;
    assert.equal(await remaining(), 599);
});

test('verified StoreKit grants weekly and monthly allowances per Apple transaction', async () => {
    config.dailySubscriptionAllowanceEnabled = false;
    const monthly = await attach(codes[0], { environment: 'Production' });
    assert.equal(monthly.subscriberDailyRemaining, 600);
    const weeklyProof = {
        productId: 'ai_notes_pro_weekly_subscription',
        originalTransactionId: '100000000151',
        transactionId: '100000000152',
        expiresDate: time.getTime() + 86400000,
    };
    const weekly = await attach(codes[1], weeklyProof);
    assert.equal(weekly.subscriberAllowancePeriod, 'weekly');
    assert.equal(weekly.subscriberDailyRemaining, 150);
    assert.equal(weekly.subscriberResetAt, new Date(weeklyProof.expiresDate).toISOString());
    const request = await generation.begin(codes[1], randomUUID(), '/notes', source);
    await generation.finish(request.record._id, 200, { notes: 'Paid weekly note' });
    config.monthlySubscriptionCredits = 800;
    assert.equal((await credits.balance(codes[0])).subscriberDailyRemaining, 600);
    assert.equal((await credits.balance(codes[1])).subscriberDailyRemaining, 149);

    time = new Date(weeklyProof.expiresDate);
    const renewed = await attach(codes[1], {
        ...weeklyProof,
        transactionId: '100000000153',
        expiresDate: time.getTime() + 7 * 86400000,
    });
    assert.equal(renewed.subscriberDailyRemaining, 200);
    config.dailySubscriptionAllowanceEnabled = true;
    const daily = await credits.balance(codes[1]);
    assert.equal(daily.subscriberAllowancePeriod, 'daily');
    assert.equal(daily.subscriberDailyRemaining, 10);
});

test('exhausted trial requests require consent to spend wallet credits', async () => {
    config.dailySubscriptionAllowanceEnabled = false;
    await attach(codes[0], { offerType: 1, offerDiscountType: 'FREE_TRIAL' });
    const { quotaId } = await status(codes[0]);
    await Subscription.updateOne({ _id: quotaId }, {
        $set: { periodUsageTransactionId: proof().transactionId, periodRequestCount: 2 },
    });
    const before = await credits.balance(codes[0]);
    const last = await generation.begin(codes[0], randomUUID(), '/notes', source);
    await generation.finish(last.record._id, 200, { notes: 'Last trial note' });
    await assert.rejects(generation.begin(codes[0], randomUUID(), '/notes', source),
        error => error.status === 429);
    const exhausted = await credits.balance(codes[0]);
    assert.equal(exhausted.subscriberDailyRemaining, 0);
    assert.equal(exhausted.credits, before.credits);
    assert.equal(exhausted.freeCreditsRemaining, before.freeCreditsRemaining);
});

test('trial credit controls are independent of the paid daily mode and the wallet', async () => {
    config.freeTrialCreditsEnabled = false;
    config.freeTrialCredits = 4;
    await attach(codes[0], { offerType: 1, offerDiscountType: 'FREE_TRIAL' });
    const disabled = await credits.balance(codes[0]);
    assert.equal((await status(codes[0])).isPro, true);
    assert.equal(disabled.subscriberAllowancePeriod, 'trial');
    assert.equal(disabled.subscriberDailyLimit, 0);
    assert.equal(disabled.subscriberDailyRemaining, 0);
    assert.equal(disabled.freeCreditsRemaining, 7);
    assert.equal(disabled.credits, 20);

    config.freeTrialCreditsEnabled = true;
    assert.equal((await credits.balance(codes[0])).subscriberDailyRemaining, 0);
    config.dailySubscriptionAllowanceEnabled = false;
    const newTrial = await attach(codes[1], {
        originalTransactionId: '100000000201',
        transactionId: '100000000202',
        offerType: 1,
        offerDiscountType: 'FREE_TRIAL',
    });
    assert.equal(newTrial.subscriberDailyRemaining, 4);
});

test('an existing trial keeps its grant and usage after backfill, settings changes and recovery', async () => {
    config.dailySubscriptionAllowanceEnabled = false;
    const trial = { offerType: 1, offerDiscountType: 'FREE_TRIAL' };
    await attach(codes[0], trial);
    const { quotaId } = await status(codes[0]);
    const request = await generation.begin(codes[0], randomUUID(), '/notes', source);
    await generation.finish(request.record._id, 200, { notes: 'Trial note' });

    // Simulate a trial from the previous deployment present only in its backup.
    await AccountRecovery.updateOne({ identity: quotaId }, { $unset: { 'snapshot.trialCreditLimit': '' } });
    await Subscription.deleteOne({ _id: quotaId });
    await service.backfillTrialGrants(config);
    config.freeTrialCreditsEnabled = false;
    config.freeTrialCredits = 8;
    await service.backfillTrialGrants(config);
    await Subscription.deleteOne({ _id: quotaId });

    const refreshed = await attach(codes[0], trial);
    assert.equal(refreshed.subscriberDailyLimit, 3);
    assert.equal(refreshed.subscriberDailyRemaining, 2);
    const wallet = await credits.balance(codes[0]);
    assert.equal(wallet.credits, 20);
    assert.equal(wallet.freeCreditsRemaining, 7);
});

test('paywall copy uses the same configured credit limits as billing', () => {
    const { subscriptionPlanMessages } = require('../services/subscription-usage');
    const monthly = subscriptionPlanMessages({});
    assert.match(monthly.monthly, /600 AI credits per paid billing month/);
    assert.match(monthly.weekly, /150 AI credits per paid billing week/);
    assert.equal(subscriptionPlanMessages({
        monthlySubscriptionCredits: 803,
        weeklySubscriptionCredits: 999,
        subscriptionMessages: { weekly: 'Weekly Pro includes {credits} credits.' },
    }).weekly, 'Weekly Pro includes 200 credits.');
    assert.match(monthly.trial, /\{duration\} free trial/);
    assert.match(monthly.trial, /3 extra AI credits total/);

    const daily = subscriptionPlanMessages({
        dailySubscriptionAllowanceEnabled: true,
        subscriberDailyLimit: 12,
        freeTrialCreditsEnabled: false,
        freeTrialCredits: 4,
        subscriptionMessages: { daily: 'Includes {credits} credits per day.' },
    });
    assert.equal(daily.monthly, 'Includes 12 credits per day.');
    assert.equal(daily.weekly, daily.daily);
    assert.match(daily.trial, /adds no extra credits/);
    assert.doesNotMatch(daily.trial, /4 extra/);
});

test('weekly config mirror is persisted using the latest monthly value', async () => {
    const Config = require('../models/AppConfig');
    const { syncWeeklySubscriptionCredits } = require('../services/subscription-usage');
    const initial = await Config.create({ key: 'weekly-config-test' });
    try {
        const first = await syncWeeklySubscriptionCredits(Config, initial);
        assert.equal(first.weeklySubscriptionCredits, 150);
        assert.equal((await Config.collection.findOne({ _id: initial._id })).weeklySubscriptionCredits, 150);
        const { modifiedCount } = await Config.collection.updateOne(
            { _id: initial._id }, { $set: { monthlySubscriptionCredits: 803 } },
        );
        assert.equal(modifiedCount, 1);
        const refreshed = await syncWeeklySubscriptionCredits(Config, initial);
        assert.equal(refreshed.monthlySubscriptionCredits, 803);
        assert.equal(refreshed.weeklySubscriptionCredits, 200);
        assert.equal((await Config.collection.findOne({ _id: initial._id })).weeklySubscriptionCredits, 200);
    } finally {
        await Config.deleteOne({ _id: initial._id });
    }
});

test('an early Apple renewal rolls credits once, spends the oldest first, and expires the remainder after one period', async () => {
    Object.assign(config, {
        dailySubscriptionAllowanceEnabled: false,
        monthlySubscriptionCredits: 8,
        subscriptionRollover: { monthlyEnabled: true, maxCarryPeriods: 1 },
    });
    const first = proof();
    await Promise.all(codes.map(code => attach(code, first)));
    const verifyBucket = async (code, current, rollover) => {
        const { subscriberCreditBuckets: buckets } = await credits.balance(code);
        assert.equal(buckets?.current.remaining, current);
        assert.equal(buckets?.rollover?.remaining ?? 0, rollover);
    };
    await verifyBucket(codes[0], 8, 0);
    const spent = await generation.begin(codes[0], randomUUID(), '/notes', source);
    await generation.finish(spent.record._id, 200, { notes: 'Saved' });
    await verifyBucket(codes[1], 7, 0);

    const secondStart = first.expiresDate;
    const secondEnd = secondStart + 3600000;
    const event = {
        type: 'RENEWAL', store: 'APP_STORE', environment: 'SANDBOX', period_type: 'NORMAL',
        original_transaction_id: first.originalTransactionId, transaction_id: '100000000003',
        product_id: first.productId, purchased_at_ms: secondStart, expiration_at_ms: secondEnd,
        event_timestamp_ms: time.getTime() + 1000,
    };
    await service.webhook(event);
    await verifyBucket(codes[0], 7, 0);

    time = new Date(secondStart + 1000);
    await Promise.all(codes.map(code => verifyBucket(code, 8, 7)));
    await service.webhook(event);
    const held = await generation.begin(codes[1], randomUUID(), '/notes', source);
    await verifyBucket(codes[0], 8, 6);
    await generation.finish(held.record._id, 500, { error: 'Provider failed' });
    await verifyBucket(codes[0], 8, 7);

    time = new Date(secondEnd + 1000);
    await attach(codes[0], { transactionId: '100000000004', purchaseDate: secondEnd, expiresDate: secondEnd + 3600000 });
    await verifyBucket(codes[1], 8, 8);
    assert.equal(await LedgerEntry.countDocuments({ type: 'carry' }), 2);
    assert.equal(await LedgerAllocation.countDocuments(), 3);
});

test('a failed generation at expiry returns credits for a late continuous renewal', async () => {
    Object.assign(config, {
        dailySubscriptionAllowanceEnabled: false,
        monthlySubscriptionCredits: 8,
        subscriptionRollover: { monthlyEnabled: true, maxCarryPeriods: 1 },
    });
    const first = proof({ expiresDate: time.getTime() + 2000 });
    await attach(codes[0], first);
    const held = await generation.begin(codes[0], randomUUID(), '/notes', source);
    assert.equal((await credits.balance(codes[0])).subscriberDailyRemaining, 7);

    time = new Date(first.expiresDate + 1000);
    await generation.finish(held.record._id, 500, { error: 'Provider failed' });
    assert.equal((await credits.balance(codes[0])).subscriberDailyRemaining, 0);

    await attach(codes[0], {
        transactionId: '100000000003',
        purchaseDate: first.expiresDate,
        expiresDate: first.expiresDate + 3600000,
    });
    const { subscriberCreditBuckets: buckets } = await credits.balance(codes[0]);
    assert.equal(buckets.current.remaining, 8);
    assert.equal(buckets.rollover.remaining, 8);
});

for (const rollover of [false, true]) test(`paid monthly grant survives global reduction, restore and next renewal (rollover=${rollover})`, async () => {
    Object.assign(config, { dailySubscriptionAllowanceEnabled: false, monthlySubscriptionCredits: 600,
        subscriptionRollover: { monthlyEnabled: rollover, maxCarryPeriods: 1 } });
    const original = proof();
    await attach(codes[0], original);
    const request = await generation.begin(codes[0], randomUUID(), '/notes', source);
    await generation.finish(request.record._id, 200, { notes: 'Saved' });
    config.monthlySubscriptionCredits = 300;
    assert.equal((await credits.balance(codes[0])).subscriberDailyRemaining, 599);
    await Subscription.deleteOne({ _id: (await status(codes[0])).quotaId });
    await attach(codes[0], original);
    assert.equal((await credits.balance(codes[0])).subscriberDailyRemaining, 599);
    await service.webhook({ type: 'CANCELLATION', store: 'APP_STORE', environment: 'SANDBOX',
        original_transaction_id: original.originalTransactionId, transaction_id: original.transactionId,
        event_timestamp_ms: time.getTime() + 1, expiration_at_ms: original.expiresDate, cancel_reason: 'UNSUBSCRIBE' });
    assert.equal((await status(codes[0])).isPro, true);
    assert.equal((await credits.balance(codes[0])).subscriberDailyRemaining, 599);
    time = new Date(original.expiresDate + 1000);
    await attach(codes[0], { transactionId: '100000000099', purchaseDate: original.expiresDate,
        expiresDate: original.expiresDate + 3600000 });
    const renewed = await credits.balance(codes[0]);
    assert.equal(renewed.subscriberDailyRemaining, rollover ? 899 : 300);
    if (rollover) assert.equal(renewed.subscriberCreditBuckets.current.limit, 300);
    await attach(codes[1], { originalTransactionId: '100000000101', transactionId: '100000000102' });
    assert.equal((await credits.balance(codes[1])).subscriberDailyRemaining, 300);
});

test('backfill pins legacy monthly and weekly grants before config changes, including recovery-only records', async () => {
    config.dailySubscriptionAllowanceEnabled = false;
    await attach(codes[0]);
    await attach(codes[1], { productId: 'ai_notes_pro_weekly_subscription', originalTransactionId: '100000000901', transactionId: '100000000902' });
    await Subscription.updateMany({}, { $unset: { periodCreditLimit: '', periodCreditTransactionId: '' } });
    await AccountRecovery.updateMany({ kind: 'subscription' }, { $unset: { 'snapshot.periodCreditLimit': '', 'snapshot.periodCreditTransactionId': '' } });
    const id = (await status(codes[1])).quotaId;
    await Subscription.deleteOne({ _id: id });
    await service.backfillPaidGrants(config);
    config.monthlySubscriptionCredits = 300;
    await service.backfillPaidGrants(config);
    assert.equal((await credits.balance(codes[0])).subscriberDailyRemaining, 600);
    assert.equal((await credits.balance(codes[1])).subscriberDailyRemaining, 150);
});

test('weekly reduction and lapsed monthly resubscription use current terms only for the new period', async () => {
    Object.assign(config, { dailySubscriptionAllowanceEnabled: false, monthlySubscriptionCredits: 600 });
    const weekly = proof({ productId: 'ai_notes_pro_weekly_subscription' });
    await attach(codes[0], weekly);
    config.monthlySubscriptionCredits = 300;
    assert.equal((await credits.balance(codes[0])).subscriberDailyRemaining, 150);
    time = new Date(weekly.expiresDate + 1000);
    const next = { ...weekly, transactionId: '100000000987', purchaseDate: time.getTime(), expiresDate: time.getTime() + 3600000 };
    assert.equal((await attach(codes[0], next)).subscriberDailyRemaining, 75);
    config.monthlySubscriptionCredits = 600;
    const monthly = proof({ originalTransactionId: '100000000991', transactionId: '100000000992' });
    await attach(codes[1], monthly);
    config.monthlySubscriptionCredits = 300;
    time = new Date(monthly.expiresDate + 86400000);
    assert.equal((await status(codes[1])).isPro, false);
    const resumed = await attach(codes[1], { ...monthly, transactionId: '100000000993', purchaseDate: time.getTime(), expiresDate: time.getTime() + 3600000 });
    assert.equal(resumed.subscriberDailyRemaining, 300);
});
