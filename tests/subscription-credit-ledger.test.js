const assert = require('node:assert/strict');
const { after, before, describe, test } = require('node:test');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const AppConfig = require('../models/AppConfig');
const Account = require('../models/SubscriptionCreditAccount');
const Allocation = require('../models/SubscriptionCreditAllocation');
const Entry = require('../models/SubscriptionCreditLedgerEntry');
const { initializeSubscriptionRollover, snapshotSubscriptionPolicy } = require('../services/subscription-credit-policy');
const { openInitialPeriod } = require('../services/subscription-credit-ledger');

const now = new Date('2026-11-17T10:00:00Z');
function period(chainId, overrides = {}) {
    return {
        store: 'apple', environment: 'Sandbox', chainId, transactionId: 'transaction-1', kind: 'monthly',
        periodStart: new Date('2026-11-16T10:00:00Z'), periodEnd: new Date('2026-12-16T10:00:00Z'),
        ...overrides,
    };
}

test('policy uses the existing allowances with monthly-only rollover, disabled by default', () => {
    const config = { subscriptionRollover: { monthlyEnabled: true }, freeTrialCreditsEnabled: false };
    assert.equal(snapshotSubscriptionPolicy({}, 'monthly').rolloverEligible, false);
    const monthly = snapshotSubscriptionPolicy(config, 'monthly');
    assert.equal(monthly.grantedCredits, 600);
    assert.equal(monthly.rolloverEligible, true);
    assert.equal(monthly.maxCarryPeriods, 1);
    assert.equal(snapshotSubscriptionPolicy(config, 'weekly').grantedCredits, 150);
    assert.equal(snapshotSubscriptionPolicy(config, 'weekly').rolloverEligible, false);
    assert.equal(snapshotSubscriptionPolicy(config, 'trial').grantedCredits, 0);
    assert.equal(snapshotSubscriptionPolicy(config, 'trial', 3).grantedCredits, 3);
    assert.equal(snapshotSubscriptionPolicy(config, 'trial', 3).rolloverEligible, false);
    assert.throws(() => snapshotSubscriptionPolicy({ dailySubscriptionAllowanceEnabled: true }, 'monthly'), { status: 409 });
    for (const value of [null, { monthlyEnabled: 'true' }, { maxCarryPeriods: 2 }]) {
        assert.throws(() => snapshotSubscriptionPolicy({ subscriptionRollover: value }, 'monthly'), { status: 503 });
    }
});

test('allocation validation rejects an inconsistent balance or unauthorized expiry extension', async () => {
    const options = {
        ...period('validation'), _id: 'allocation', accountId: 'account',
        expiresAt: new Date('2026-12-16T10:00:00Z'), terms: snapshotSubscriptionPolicy({}, 'monthly'),
        available: 600, spent: 0, reserved: 0, expired: 0, revoked: 0,
    };
    await new Allocation(options).validate();
    await assert.rejects(new Allocation({ ...options, available: 601 }).validate(), /original grant/);
    await assert.rejects(new Allocation({
        ...options, expiresAt: new Date('2027-01-16T10:00:00Z'), carriedIntoTransactionId: 'transaction-2',
    }).validate(), /recorded monthly carry/);
});

describe('credit allocation transactions', () => {
    let mongo;
    before(async () => {
        mongo = await MongoMemoryReplSet.create({ binary: { version: '8.0.17' }, replSet: { count: 1 } });
        await mongoose.connect(mongo.getUri());
        await AppConfig.init();
    });
    after(async () => {
        await mongoose.disconnect();
        await mongo?.stop();
    });

    test('writes the default to an existing config and preserves operator changes', async () => {
        await AppConfig.collection.insertOne({ key: 'master_config', monthlySubscriptionCredits: 720 });
        await initializeSubscriptionRollover(AppConfig);
        let stored = await AppConfig.collection.findOne({ key: 'master_config' });
        assert.deepEqual(stored.subscriptionRollover, { monthlyEnabled: false, maxCarryPeriods: 1 });
        await AppConfig.collection.updateOne({ key: 'master_config' }, { $set: { 'subscriptionRollover.monthlyEnabled': true } });
        await initializeSubscriptionRollover(AppConfig);
        stored = await AppConfig.collection.findOne({ key: 'master_config' });
        assert.equal(stored.subscriptionRollover.monthlyEnabled, true);
        assert.equal(stored.monthlySubscriptionCredits, 720);
    });

    test('concurrent repeats share one immutable grant', async () => {
        const source = period('repeat');
        const results = await Promise.all(Array.from({ length: 5 }, () => openInitialPeriod(source, { now })));
        const first = results[0];
        assert.ok(results.every(result => result._id === first._id && result.available === 600));
        assert.equal(await Account.countDocuments({ _id: first.accountId }), 1);
        assert.equal(await Allocation.countDocuments({ accountId: first.accountId }), 1);
        assert.equal(await Entry.countDocuments({ accountId: first.accountId, type: 'grant' }), 1);
        const changedConfig = { monthlySubscriptionCredits: 750, subscriptionRollover: { monthlyEnabled: true } };
        const replay = await openInitialPeriod(source, { now, config: changedConfig });
        assert.equal(replay.terms.policyId, first.terms.policyId);
        assert.equal(replay.available, 600);
        await assert.rejects(openInitialPeriod({ ...source, kind: 'trial' }, { now }), /match the saved allocation/);
        await assert.rejects(openInitialPeriod({ ...source, transactionId: 'transaction-2' }, { now }), /already has/);
    });

    test('imports the authoritative remaining balance for existing paid and trial periods', async () => {
        const paid = await openInitialPeriod(period('paid-import'), { now, existingUsage: { limit: 600, used: 287 } });
        assert.equal(paid.available, 313);
        assert.equal(paid.spent, 287);
        const ledger = await Entry.find({ accountId: paid.accountId });
        assert.deepEqual(Object.fromEntries(ledger.map(item => [item.type, item.units])), { grant: 600, import: 287 });
        const trial = await openInitialPeriod(period('trial-import', { kind: 'trial' }), {
            now, config: { freeTrialCreditsEnabled: false }, existingUsage: { limit: 3, used: 2 },
        });
        assert.equal(trial.available, 1);
        assert.equal(trial.terms.rolloverEligible, false);
        const depleted = await openInitialPeriod(period('depleted'), { now, existingUsage: { limit: 100, used: 110 } });
        assert.equal(depleted.available, 0);
        await assert.rejects(openInitialPeriod(period('no-usage'), { now, existingUsage: { limit: 600 } }), /existing allowance and usage/);
    });

    test('separates sandbox and production and rejects a new allocation for an ended period', async () => {
        const sandbox = await openInitialPeriod(period('environment'), { now });
        const live = await openInitialPeriod(period('environment', { environment: 'Production' }), { now });
        assert.notEqual(sandbox.accountId, live.accountId);
        await assert.rejects(openInitialPeriod(period('ended'), { now: new Date('2026-12-16T10:00:00Z') }), /not active/);
    });

    test('a failed ledger write rolls back the account and allocation', async t => {
        const source = period('rollback');
        const entryWrite = t.mock.method(Entry, 'create', async () => { throw new Error('Ledger write failed'); });
        await assert.rejects(openInitialPeriod(source, { now }), /Ledger write failed/);
        entryWrite.mock.restore();
        assert.equal(await Account.countDocuments({ chainId: source.chainId }), 0);
        const retried = await openInitialPeriod(source, { now });
        assert.equal(retried.available, 600);
    });
});
