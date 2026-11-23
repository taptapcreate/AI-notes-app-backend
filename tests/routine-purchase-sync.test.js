const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPurchases } = require('../services/purchases');
const user = { recoveryCode: 'TESTCODE' };
const empty = () => ({ data: { subscriber: { non_subscriptions: {}, entitlements: {}, subscriptions: {} } } });
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};

test('passive polls share in-flight reconciliation and successful checks for thirty seconds', async () => {
    let reads = 0, clock = 0;
    const held = deferred();
    const service = createPurchases({ credits: {}, apiKey: 'test', now: () => clock,
        axios: { get: async () => { reads++; return held.promise; } } });
    const a = service.syncRoutine(user), b = service.syncRoutine(user);
    assert.equal(a, b);
    held.resolve(empty());
    await Promise.all([a, b]);
    await service.syncRoutine(user);
    assert.equal(reads, 1);
    clock = 30000;
    await service.syncRoutine(user);
    assert.equal(reads, 2);
    await service.syncRoutine({ recoveryCode: 'OTHERACCOUNT' });
    assert.equal(reads, 3);
});

test('failed reconciliation is retried and never becomes a successful cooldown', async () => {
    let reads = 0;
    const service = createPurchases({ credits: {}, apiKey: 'test', axios: { get: async () => {
        if (++reads === 1) throw Error('offline');
        return empty();
    } } });
    await assert.rejects(service.syncRoutine(user), /temporarily unavailable/);
    await service.syncRoutine(user);
    assert.equal(reads, 2);
});

test('explicit purchases and membership bypass passive polling reuse', async () => {
    let reads = 0;
    const service = createPurchases({ credits: {}, apiKey: 'test',
        axios: { get: async () => { reads++; return empty(); } } });
    await service.syncRoutine(user);
    await service.sync(user, { required: true });
    assert.equal(reads, 2);
    await service.syncRoutine(user);
    assert.equal(reads, 3, 'explicit sync invalidates a previous passive window');
    await service.subscriptionStatus(user);
    await service.subscriptionStatus(user);
    assert.equal(reads, 5, 'membership is checked afresh every time');
});

test('an older in-flight poll cannot reinstate a cooldown after explicit verification', async () => {
    let reads = 0;
    const old = deferred();
    const service = createPurchases({ credits: {}, apiKey: 'test',
        axios: { get: async () => ++reads === 1 ? old.promise : empty() } });
    const poll = service.syncRoutine(user);
    await new Promise(resolve => setImmediate(resolve));
    await service.sync(user, { required: true });
    old.resolve(empty());
    await poll;
    await service.syncRoutine(user);
    assert.equal(reads, 3);
});
