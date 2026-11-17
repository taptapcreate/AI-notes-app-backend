const { createHash } = require('node:crypto');
const Account = require('../models/SubscriptionCreditAccount');
const Allocation = require('../models/SubscriptionCreditAllocation');
const Entry = require('../models/SubscriptionCreditLedgerEntry');
const { createAccountTransactions } = require('./account-transactions');
const { CreditError } = require('./credit-policy');
const { snapshotSubscriptionPolicy } = require('./subscription-credit-policy');

const transactions = createAccountTransactions(Account, Entry);
const accounts = transactions.bind(Account);
const allocations = transactions.bind(Allocation);
const entries = transactions.bind(Entry);

function digest(parts) {
    return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function checkedPeriod({ store, environment, chainId, transactionId, kind, periodStart, periodEnd }) {
    const validId = value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 512;
    if (!['apple', 'google'].includes(store) || !['Production', 'Sandbox'].includes(environment) ||
        !validId(chainId) || !validId(transactionId) || !['monthly', 'weekly', 'trial'].includes(kind) ||
        !(periodStart instanceof Date) || !(periodEnd instanceof Date) || !(periodStart < periodEnd))
        throw new CreditError(400, 'Invalid verified subscription period');
    const accountId = digest([store, environment, chainId]);
    return {
        accountId, allocationId: digest([accountId, transactionId]), store, environment, chainId,
        transactionId, kind, periodStart: new Date(periodStart), periodEnd: new Date(periodEnd),
    };
}

function recordEntry({ accountId, allocationId, transactionId }, type, units, now) {
    const operationId = `${type}:${digest([transactionId])}`;
    return entries.create({
        _id: digest([accountId, operationId]),
        accountId, operationId, type, units,
        allocations: units === 0 ? [] : [{ allocationId, units }],
        createdAt: now,
    });
}

// Only call with a server-verified store period and authoritative usage.
// The first allocation is independent of the legacy balance. Renewals will
// have a separate path because they must settle the preceding allocation.
async function openInitialPeriod(period, { config, existingUsage, now = new Date() } = {}) {
    const identity = checkedPeriod(period);
    const { accountId, allocationId, store, environment, chainId, transactionId, kind, periodStart, periodEnd } = identity;
    await Promise.all([Account.init(), Allocation.init()]);
    return transactions.run(async () => {
        const existing = await allocations.findById(allocationId);
        if (existing) {
            if (existing.kind !== kind || existing.periodStart.getTime() !== periodStart.getTime() ||
                existing.periodEnd.getTime() !== periodEnd.getTime())
                throw new CreditError(409, 'Subscription transaction does not match the saved allocation');
            return existing.toObject();
        }
        if (await accounts.exists({ _id: accountId }))
            throw new CreditError(409, 'Subscription already has a credit allocation');
        if (!(periodStart <= now && now < periodEnd))
            throw new CreditError(409, 'Subscription period is not active');

        if (existingUsage !== undefined &&
            (!Number.isSafeInteger(existingUsage?.limit) || !Number.isSafeInteger(existingUsage?.used) ||
                existingUsage.used < 0))
            throw new CreditError(400, 'Import requires the existing allowance and usage');
        const terms = snapshotSubscriptionPolicy(config, kind, existingUsage?.limit);
        // The previous limit may have been reduced after the customer spent
        // credits. Preserve the spendable balance in that case, which is zero.
        const spent = Math.min(terms.grantedCredits, existingUsage?.used ?? 0);
        const allocation = await allocations.create({
            _id: allocationId,
            accountId, transactionId, kind, periodStart, periodEnd, expiresAt: periodEnd, terms,
            available: terms.grantedCredits - spent,
            reserved: 0, spent, expired: 0, revoked: 0,
        });
        await accounts.create({ _id: accountId, store, environment, chainId, currentAllocationId: allocationId });
        await recordEntry(identity, 'grant', terms.grantedCredits, now);
        if (spent > 0) await recordEntry(identity, 'import', spent, now);
        return allocation.toObject();
    });
}

module.exports = { openInitialPeriod };
