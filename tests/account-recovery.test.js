const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const User = require('../models/User');
const Subscription = require('../models/AppleSubscription');
const Backup = require('../models/AccountRecovery');
const { createAccountRecovery } = require('../services/account-recovery');
let mongo, wallet, subscription;
before(async () => {
    mongo = await MongoMemoryReplSet.create({ binary: { version: '8.0.17' }, replSet: { count: 1 } });
    await mongoose.connect(mongo.getUri(), { dbName: 'account_recovery_tests' });
    await Promise.all([User.init(), Subscription.init(), Backup.init()]);
    wallet = createAccountRecovery({ Account: User, Backup, kind: 'wallet' });
    subscription = createAccountRecovery({ Account: Subscription, Backup, kind: 'subscription' });
});
after(async () => { await mongoose.disconnect(); await mongo?.stop(); });
beforeEach(async () => { await Promise.all([User.deleteMany({}), Subscription.deleteMany({}), Backup.deleteMany({})]); });
async function seed(credits = 12) {
    return User.create({ recoveryCode: 'TESTCODE', deviceId: 'stable-device', credits, totalFreeCredits: 4,
        adCredits: 2, welcomePackVersion: 1, welcomeGrantClaimedAt: new Date('2026-11-01'),
        appleSubscriptionIds: ['apple-family'], processedPurchaseAliases: ['verified-purchase'],
        processedTransactions: [{ transactionId: 'verified-purchase', credits: 12, source: 'Apple' }] });
}
test('wallet deletion restores the last committed amounts and original purchase identities', async () => {
    const original = await seed();
    await wallet.run('TESTCODE', async ({ account, session }) => {
        await User.updateOne({ _id: account._id }, { $inc: { credits: -3, totalFreeCredits: -2 } }, { session });
    });
    await User.deleteOne({ recoveryCode: 'TESTCODE' });
    const { snapshot } = await wallet.run('TESTCODE');
    assert.equal(String(snapshot._id), String(original._id));
    assert.equal(snapshot.credits, 9); assert.equal(snapshot.totalFreeCredits, 2); assert.equal(snapshot.adCredits, 2);
    assert.deepEqual(snapshot.processedPurchaseAliases, ['verified-purchase']);
    assert.equal(snapshot.processedTransactions[0].transactionId, 'verified-purchase');
    assert.deepEqual(snapshot.appleSubscriptionIds, ['apple-family']);
    assert.equal(snapshot.deviceId, 'stable-device');
    assert.equal(snapshot.welcomeGrantClaimedAt.toISOString(), '2026-11-01T00:00:00.000Z');
    assert.equal((await wallet.run('TESTCODE')).snapshot.credits, 9);
});
test('parallel debits and checkpoints cannot restore spent purchased credits', async () => {
    const original = await seed(2);
    await User.updateOne({ _id: original._id }, { $set: { totalFreeCredits: 0, adCredits: 0 } });
    await wallet.run('TESTCODE');
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => wallet.run('TESTCODE', async ({ account, session }) => {
        if (account.credits < 1) throw new Error('Insufficient credits');
        await User.updateOne({ _id: account._id }, { $inc: { credits: -1 } }, { session });
    })));
    assert.equal(results.filter(x => x.status === 'fulfilled').length, 2);
    await User.deleteOne({ _id: original._id });
    assert.equal((await wallet.run('TESTCODE')).snapshot.credits, 0);
});
test('failed transaction rolls back both the balance mutation and its snapshot', async () => {
    await seed(); await wallet.run('TESTCODE');
    await assert.rejects(wallet.run('TESTCODE', async ({ account, session }) => {
        await User.updateOne({ _id: account._id }, { $inc: { credits: -8 } }, { session });
        await wallet.checkpoint('TESTCODE', session);
        throw new Error('Simulated failure after checkpoint');
    }));
    assert.equal((await User.findOne({ recoveryCode: 'TESTCODE' })).credits, 12);
    await User.deleteMany({});
    assert.equal((await wallet.run('TESTCODE')).snapshot.credits, 12);
});
test('subscription deletion preserves identity, quota epoch, verification state and daily usage', async () => {
    const record = await Subscription.create({ _id: 'apple-family', environment: 'Sandbox', originalTransactionId: '123456',
        quotaEpoch: 'same-epoch', dailyRequestCount: 3, lastRequestReset: new Date('2026-11-15'),
        expiresAt: new Date('2026-12-01'), revokedTransactions: ['revoked-transaction'], migratedWallets: ['wallet-hash'] });
    await subscription.run(record._id);
    await Subscription.deleteOne({ _id: record._id });
    const { snapshot } = await subscription.run(record._id);
    assert.equal(snapshot.dailyRequestCount, 3); assert.equal(snapshot.quotaEpoch, 'same-epoch');
    assert.equal(snapshot.originalTransactionId, '123456');
    assert.equal(snapshot.expiresAt.toISOString(), '2026-12-01T00:00:00.000Z');
    assert.deepEqual(snapshot.revokedTransactions, ['revoked-transaction']);
    assert.deepEqual(snapshot.migratedWallets, ['wallet-hash']);
});
test('missing or invalid backups never generate a new allowance', async () => {
    await assert.rejects(wallet.run('UNKNOWN1'), e => e.status === 404);
    assert.equal(await User.countDocuments(), 0);
    await seed(); await wallet.run('TESTCODE'); await User.deleteMany({});
    await Backup.updateOne({ identity: 'TESTCODE' }, { $set: { 'snapshot.credits': -1 } });
    await assert.rejects(wallet.run('TESTCODE'), e => e.status === 503);
    assert.equal(await User.countDocuments(), 0);
    await assert.rejects(wallet.checkpoint('TESTCODE', null), /active transaction/);
});
