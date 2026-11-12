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
        entitlement: (user) => service.status(user),
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
