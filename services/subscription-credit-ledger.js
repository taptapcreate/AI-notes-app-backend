const { createHash } = require('node:crypto');
const Account = require('../models/SubscriptionCreditAccount');
const Allocation = require('../models/SubscriptionCreditAllocation');
const Entry = require('../models/SubscriptionCreditLedgerEntry');
const { createAccountTransactions } = require('./account-transactions');
const { CreditError } = require('./credit-policy');
const { rolloverControls, snapshotSubscriptionPolicy } = require('./subscription-credit-policy');

const { requestHistoryUsage } = require('./subscription-usage');
const { timeSubscriptionOperation: timeSubscription } = require('./subscription-timing');

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
        const allocation = await createAllocation(identity, config, existingUsage, now);
        await accounts.create({ _id: accountId, store, environment, chainId, currentAllocationId: allocationId });
        return allocation.toObject();
    });
}

async function createAllocation(identity, config, existingUsage, now) {
    const { accountId, allocationId, transactionId, kind, periodStart, periodEnd } = identity;
    const terms = snapshotSubscriptionPolicy(config, kind, existingUsage?.limit);
    const spent = Math.min(terms.grantedCredits, existingUsage?.used ?? 0);
    const allocation = await allocations.create({
        _id: allocationId, accountId, transactionId, kind, periodStart, periodEnd, expiresAt: periodEnd, terms,
        available: terms.grantedCredits - spent, reserved: 0, spent, expired: 0, revoked: 0,
    });
    await recordEntry(identity, 'grant', terms.grantedCredits, now);
    if (spent) await recordEntry(identity, 'import', spent, now);
    return allocation;
}

function appleAccountId(record) {
    return digest(['apple', record.environment, record.originalTransactionId]);
}

async function closeAvailable(allocation, type, now, session) {
    const units = allocation.available;
    if (allocation.closedAt) return;
    allocation.closedAt = now;
    allocation.available = 0;
    allocation[type === 'revoke' ? 'revoked' : 'expired'] += units;
    await allocation.save({ session });
    if (units) await recordEntry({ accountId: allocation.accountId, allocationId: allocation._id,
        transactionId: allocation.transactionId }, type, units, now);
}

function monthlyUsage(...args) {
    return timeSubscription('usage_ledger', () => readMonthlyUsage(...args));
}
async function readMonthlyUsage(record, config, now, session, requests) {
    const rollover = rolloverControls(config);
    if (!record?.originalTransactionId || !record.transactionId) return null;
    return transactions.withSession(session, async () => {
        const accountId = appleAccountId(record);
        const account = await timeSubscription('db.ledger_account.findById', () => accounts.findById(accountId));
        const previous = account && await timeSubscription('db.allocation.findById', () => allocations.findById(account.currentAllocationId));
        if (account && !previous)
            throw new CreditError(503, 'Subscription allowance needs support review');
        if (previous && record.purchaseDate < previous.periodStart)
            return null;
        const eligible = record.allowancePeriod === 'monthly' && record.purchaseDate instanceof Date &&
            record.expiresAt instanceof Date && record.purchaseDate <= now && now < record.expiresAt &&
            !record.revokedAt && !record.isUpgraded && !record.revokedTransactions?.includes(record.transactionId);
        if (!eligible) {
            // An ordinary expiry can be followed by a late, continuous renewal.
            // Hold its balance until that renewal arrives, while making it unspendable.
            if (previous && (record.revokedAt || record.isUpgraded ||
                (record.allowancePeriod && record.allowancePeriod !== 'monthly' && record.purchaseDate >= previous.periodStart))) {
                const adjacent = await allocations.find({ accountId, $or: [
                    { _id: previous._id }, { carriedIntoTransactionId: previous.transactionId },
                ] });
                for (const allocation of adjacent) {
                    await closeAvailable(allocation, record.revokedAt ? 'revoke' : 'expire', now, session);
                }
            }
            if (previous && previous.transactionId === record.transactionId && record.allowancePeriod === 'monthly') {
                return displayUsage(record, config, now, previous, null, false);
            }
            return null;
        }
        const id = checkedPeriod({
            store: 'apple', environment: record.environment, chainId: record.originalTransactionId,
            transactionId: record.transactionId, kind: 'monthly', periodStart: record.purchaseDate, periodEnd: record.expiresAt,
        });
        let current = previous?.transactionId === record.transactionId ? previous : null;
        if (!current) {
            if (config.dailySubscriptionAllowanceEnabled === true || (!account && !rollover.monthlyEnabled))
                return null;
            if (previous && id.periodStart <= previous.periodStart) return null;
            const pending = await requests.exists({
                state: 'pending', 'reservation.pro': true, 'reservation.subscriptionId': record._id,
                'reservation.periodTransactionId': record.transactionId,
                'reservation.ledger': { $exists: false },
            }).session(session);
            if (pending) return null;
            const legacy = await requestHistoryUsage(record, config, now, session, requests);
            current = await createAllocation(id, config, { limit: legacy.subscriberDailyLimit, used: legacy.subscriberDailyUsage }, now);
            if (previous) {
                const oldCarry = await allocations.findOne({ accountId, carriedIntoTransactionId: previous.transactionId });
                if (oldCarry) await closeAvailable(oldCarry, 'expire', now, session);
                // Apple and RevenueCat can serialize the same boundary at different precisions.
                const contiguous = Math.abs(id.periodStart - previous.periodEnd) < 1000;
                if (rollover.monthlyEnabled && previous.terms.rolloverEligible && !previous.closedAt && contiguous &&
                    !record.revokedTransactions?.includes(previous.transactionId) && (previous.available || previous.reserved)) {
                    previous.carriedIntoTransactionId = current.transactionId;
                    previous.expiresAt = current.periodEnd;
                    previous.carriedCredits = previous.available + previous.reserved;
                    await previous.save({ session });
                    await recordEntry({ accountId, allocationId: previous._id, transactionId: previous.transactionId },
                        'carry', previous.available, now);
                } else {
                    await closeAvailable(previous, record.revokedTransactions?.includes(previous.transactionId) ? 'revoke' : 'expire', now, session);
                }
                account.currentAllocationId = current._id;
                await account.save({ session });
            } else {
                await accounts.create({ _id: accountId, store: id.store, environment: id.environment,
                    chainId: id.chainId, currentAllocationId: current._id });
            }
        }
        let carry = await timeSubscription('db.allocation.findOne', () => allocations.findOne({ accountId, carriedIntoTransactionId: current.transactionId }));
        if (carry && record.revokedTransactions?.includes(carry.transactionId)) {
            await closeAvailable(carry, 'revoke', now, session);
            carry = null;
        }
        return displayUsage(record, config, now, current, carry, !current.closedAt && now < current.expiresAt);
    });
}

function displayUsage(record, config, now, current, carry, spendable) {
    const { subscriptionUsage } = require('./subscription-usage');
    const usage = subscriptionUsage(record, config, now);
    const currentRemaining = spendable ? current.available : 0;
    const rolloverRemaining = spendable ? carry?.available ?? 0 : 0;
    const carryEntryLimit = carry?.carriedCredits ?? 0;
    return {
        ...usage,
        subscriptionUsageKey: digest(['apple', record._id, current.transactionId]),
        subscriptionTrackingSource: 'ledger',
        subscriberAllowancePeriod: 'monthly',
        subscriberResetAt: current.expiresAt.toISOString(),
        subscriberDailyLimit: current.terms.grantedCredits + carryEntryLimit,
        subscriberDailyUsage: current.terms.grantedCredits + carryEntryLimit - currentRemaining - rolloverRemaining,
        subscriberDailyRemaining: currentRemaining + rolloverRemaining,
        subscriberCreditBuckets: {
            current: { limit: current.terms.grantedCredits, remaining: currentRemaining, expiresAt: current.expiresAt.toISOString() },
            rollover: carry && { remaining: rolloverRemaining, expiresAt: carry.expiresAt.toISOString() },
        },
    };
}

async function reserveMonthly(record, units, requestId, now, session) {
    return transactions.withSession(session, async () => {
        const account = await accounts.findById(appleAccountId(record));
        const current = await allocations.findById(account.currentAllocationId);
        const carry = await allocations.findOne({ accountId: account._id, carriedIntoTransactionId: current.transactionId });
        let remaining = units;
        const held = [];
        for (const allocation of [carry, current]) {
            if (!allocation || allocation.closedAt || allocation.expiresAt <= now || record.revokedTransactions?.includes(allocation.transactionId)) continue;
            const used = Math.min(remaining, allocation.available);
            if (!used) continue;
            allocation.available -= used;
            allocation.reserved += used;
            await allocation.save({ session });
            held.push({ allocationId: allocation._id, units: used });
            remaining -= used;
        }
        if (remaining) throw new CreditError(409, 'Your subscription balance changed. Please try again.');
        await writeRequestEntry(account._id, 'reserve', requestId, held, now);
        return held;
    });
}

function writeRequestEntry(accountId, type, requestId, held, now) {
    const operationId = `${type}:${requestId}`;
    return entries.create({ _id: digest([accountId, operationId]), accountId, operationId, type,
        allocations: held, units: held.reduce((sum, item) => sum + item.units, 0), createdAt: now });
}

async function settleMonthly(held, requestId, success, record, now, session) {
    return transactions.withSession(session, async () => {
        const groups = new Map();
        let accountId;
        for (const item of held) {
            const allocation = await allocations.findById(item.allocationId);
            if (!allocation || allocation.reserved < item.units)
                throw new CreditError(503, 'Subscription reservation needs support review');
            accountId = allocation.accountId;
            allocation.reserved -= item.units;
            const revoked = record?.revokedTransactions?.includes(allocation.transactionId) ||
                !!record?.revokedAt && (record.transactionId === allocation.transactionId ||
                    record.transactionId === allocation.carriedIntoTransactionId);
            // A failed request can settle between expiry and the arrival of a continuous renewal.
            // Keep its units eligible to carry while the expired allocation remains unspendable.
            const awaitingRenewal = allocation.kind === 'monthly' && allocation.terms.rolloverEligible &&
                !allocation.carriedIntoTransactionId && record?.transactionId === allocation.transactionId;
            const expired = allocation.closedAt || (allocation.expiresAt <= now && !awaitingRenewal) || record?.isUpgraded ||
                (allocation.carriedIntoTransactionId && record?.transactionId !== allocation.carriedIntoTransactionId) ||
                (!allocation.carriedIntoTransactionId && record?.transactionId !== allocation.transactionId);
            const field = success ? 'spent' : revoked ? 'revoked' : expired ? 'expired' : 'available';
            allocation[field] += item.units;
            await allocation.save({ session });
            const type = { spent: 'consume', revoked: 'revoke', expired: 'expire', available: 'release' }[field];
            const items = groups.get(type) ?? [];
            items.push(item);
            groups.set(type, items);
        }
        for (const [type, items] of groups) await writeRequestEntry(accountId, type, requestId, items, now);
    });
}

async function initializeLedger() {
    await Promise.all([Account.init(), Allocation.init(), Entry.init()]);
}

module.exports = { openInitialPeriod, initializeLedger, monthlyUsage, reserveMonthly, settleMonthly };
