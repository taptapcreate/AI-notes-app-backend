const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPurchases, creditPackAmount } = require('../services/purchases');
const { BUNDLE_ID } = require('../services/apple-subscriptions');
const { createRevenueCatHandler } = require('../routes/revenuecat');

const ids = ['lite', 'power', 'pro', 'elite', 'ultimate', 'mega', 'supreme'].map(
    (tier) => `ai_notes_${tier}_pack_credits`,
);
const [productId] = ids;
const cutover = Date.parse('2026-01-01T00:00:00Z');
const user = { recoveryCode: 'TESTCODE' };

test('all Apple pack quantities switch at the verified cutover; Play keeps the original catalog', () => {
    for (const [store, time, expected] of [
        ['app_store', cutover - 1, [100, 350, 550, 900, 1800, 3500, 5000]],
        ['MAC_APP_STORE', cutover, [20, 50, 100, 200, 350, 750, 1500]],
        ['PLAY_STORE', cutover, [100, 350, 550, 900, 1800, 3500, 5000]],
    ]) {
        assert.deepEqual(ids.map((id) => creditPackAmount(id, { store, purchased_at_ms: time }, cutover)), expected);
    }
    assert.equal(creditPackAmount(productId, { store: 'app_store' }, cutover), undefined);
});

test('RevenueCat sync and signed Mac proof grant the amounts for their original purchase time', async () => {
    const grants = [];
    const purchase = { productId, transactionId: '1234500001' };
    const service = createPurchases({
        credits: { grantPurchase: async (_code, _aliases, amount) => (grants.push(amount), { applied: true }) },
        axios: { get: async () => ({ data: { subscriber: { non_subscriptions: {
            [productId]: [
                { store: 'app_store', store_transaction_id: 'ios-before', purchase_date: new Date(cutover - 1000).toISOString() },
                { store: 'app_store', store_transaction_id: 'ios-after', purchase_date: new Date(cutover).toISOString() },
                { store: 'mac_app_store', store_transaction_id: 'undated' },
            ],
        } } } }) },
        apiKey: 'local-test',
        applePackCutover: cutover,
        verifyApple: async () => ({ ...purchase, bundleId: BUNDLE_ID, type: 'Consumable', environment: 'Sandbox', purchaseDate: cutover }),
    });
    const iOS = await service.sync(user, { purchase: { productId, transactionId: 'ios-after' } });
    assert.equal(iOS.purchase.credits, 20);
    assert.equal(iOS.synced, 2);
    const mac = await service.confirmApple(user, 'signed-test', purchase);
    assert.equal(mac.purchase.credits, 20);
    assert.deepEqual(grants, [100, 20, 20]);
});

test('authenticated webhooks grant new Apple amounts and hold incomplete events for retry', async () => {
    const grants = [];
    const handler = createRevenueCatHandler({
        secret: 'local-test',
        credits: { byCode: async () => user, grantPurchase: async (_code, _aliases, amount) => {
            grants.push(amount);
            return { applied: false };
        } },
        applePackCutover: cutover,
        logger: { error() {} },
    });
    const event = { type: 'NON_RENEWING_PURCHASE', product_id: productId, store: 'APP_STORE',
        app_user_id: user.recoveryCode, transaction_id: 'apple-after' };
    const res = { code: 200, status(code) { this.code = code; return this; }, json() { return this; } };
    const req = { headers: { authorization: 'Bearer local-test' }, body: { event } };
    await handler(req, res);
    assert.equal(res.code, 503);
    assert.deepEqual(grants, []);
    event.purchased_at_ms = cutover;
    res.code = 200;
    await handler(req, res);
    assert.equal(res.code, 200);
    assert.deepEqual(grants, [20]);
});
