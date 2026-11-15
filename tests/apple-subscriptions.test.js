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
        ].map((model) => model.deleteMany({})),
    );
    time = new Date('2026-11-13T00:00:00Z');
    config = {
        dailyFreeCreditsEnabled: false,
        welcomePackCredits: 7,
        subscriberDailyLimit: 10,
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


test('restoring after collection deletion gives a previously linked subscription its full configured allowance', async () => {
    const code = codes[0];
    await User.updateOne({ recoveryCode: code }, { $set: { dailyRequestCount: 10 } });
    await attach(code);
    const membership = await status(code);
    assert.equal((await credits.balance(code)).subscriberDailyRemaining, 0);
    await Subscription.collection.drop();
    assert.equal((await credits.balance(code)).subscriberDailyRemaining, 10);
    assert.equal((await attach(code)).subscriberDailyRemaining, 10);
    assert.equal((await status(code)).quotaId, membership.quotaId);
    const wallet = await credits.byCode(code);
    assert.equal(wallet.credits, 20);
    assert.equal(wallet.totalFreeCredits, 7);
});

test('verified StoreKit proof rebuilds a missing linked record and a prior request cannot refund its new count', async () => {
    const code = codes[0];
    const payload = JSON.stringify(proof());
    await service.attach(code, [payload]);
    const before = await generation.begin(code, randomUUID(), '/notes', source, [payload]);
    await Subscription.deleteMany({});
    const after = await generation.begin(code, randomUUID(), '/notes', source, [payload]);
    assert.equal(after.record.reservation.subscriptionId, before.record.reservation.subscriptionId);
    assert.notEqual(after.record.reservation.quotaEpoch, before.record.reservation.quotaEpoch);
    await generation.finish(before.record._id, 500, { error: 'AI unavailable' });
    assert.equal((await credits.balance(code)).subscriberDailyRemaining, 9);
});

test('request-history fallback shares one allowance across Apple wallets and respects recreated quota epochs', async () => {
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
    assert.equal((await credits.balance(codes[0])).subscriberDailyRemaining, 2);
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
