const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { createAccountDeletion } = require('../services/account-deletion');
const User = require('../models/User');
const AppleSubscription = require('../models/AppleSubscription');
const CreditRegistration = require('../models/CreditRegistration');
const GenerationRequest = require('../models/GenerationRequest');
const PendingPurchase = require('../models/PendingPurchase');
const PurchaseClaim = require('../models/PurchaseClaim');
const NotificationToken = mongoose.model('DeletionTestToken', new mongoose.Schema({ recoveryCode: String }));
const DeletedAccount = mongoose.model('DeletedAccount', new mongoose.Schema({ _id: String }));

test('account deletion is retryable, cleans linked data, and preserves another wallet and shared Apple usage', async (t) => {
    const mongo = await MongoMemoryReplSet.create({ binary: { version: '8.0.17' }, replSet: { count: 1 } });
    t.after(async () => { await mongoose.disconnect(); await mongo.stop(); });
    await mongoose.connect(mongo.getUri(), { dbName: 'account_deletion_test' });
    await Promise.all(Object.values(mongoose.models).map(model => model.init()));
    const code = 'TEST-DELETE';
    const another = 'TEST-KEEP';
    const hash = createHash('sha256').update(code).digest('hex');
    await User.create([
        { recoveryCode: code, credits: 30, appleSubscriptionIds: ['shared'] },
        { recoveryCode: another, credits: 10, appleSubscriptionIds: ['shared'], switchHistory: [{ fromCode: code }] },
    ]);
    await CreditRegistration.create({ _id: 'device-identity', recoveryCode: code });
    await AppleSubscription.create({ _id: 'shared', environment: 'Production', originalTransactionId: '1', dailyRequestCount: 6, migratedWallets: [hash, 'other'] });
    await NotificationToken.create([{ recoveryCode: code }, { recoveryCode: another }]);
    await PurchaseClaim.create({ _id: 'claimed-purchase', recoveryCode: code });
    await PendingPurchase.create({ transactionId: 'pending-test', rcAppUserId: code, productId: 'pack', credits: 5 });
    await GenerationRequest.create({ _id: 'request', recoveryCode: code, state: 'pending', endpoint: 'notes',
        requestId: 'request', bodyHash: 'hash', reservation: { pro: true }, leaseUntil: new Date(Date.now() + 30000) });
    let providerCalls = 0;
    let providerAvailable = false;
    const deletion = createAccountDeletion({ User, AppleSubscription, CreditRegistration, GenerationRequest,
        PendingPurchase, PurchaseClaim, NotificationToken, DeletedAccount,
        deleteCustomer: async () => { providerCalls++; if (!providerAvailable) throw new Error('Unavailable'); },
    });
    await assert.rejects(deletion.remove(code), { status: 409 });
    assert.equal(providerCalls, 0);
    await GenerationRequest.updateOne({ _id: 'request' }, { state: 'succeeded', result: { notes: 'saved output' } });
    await assert.rejects(deletion.remove(code), /Unavailable/);
    assert.ok(await User.exists({ recoveryCode: code }));
    providerAvailable = true;
    assert.deepEqual(await deletion.remove(code), { deleted: true });
    assert.deepEqual(await deletion.remove(code), { deleted: true });
    assert.equal(providerCalls, 2);
    assert.equal(await User.exists({ recoveryCode: code }), null);
    for (const model of [CreditRegistration, GenerationRequest, NotificationToken, PurchaseClaim]) {
        assert.equal(await model.exists({ recoveryCode: code }), null);
    }
    assert.equal(await PendingPurchase.exists({ rcAppUserId: code }), null);
    assert.equal((await PurchaseClaim.findById('claimed-purchase')).recoveryCode, 'deleted');
    assert.equal((await User.findOne({ recoveryCode: another })).credits, 10);
    assert.ok(await NotificationToken.exists({ recoveryCode: another }));
    const subscription = await AppleSubscription.findById('shared');
    assert.equal(subscription.dailyRequestCount, 6);
    assert.deepEqual([...subscription.migratedWallets], ['other']);
    assert.equal(await deletion.wasDeleted(code), true);
});
