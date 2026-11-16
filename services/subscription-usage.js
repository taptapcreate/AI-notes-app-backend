const { createHash } = require('node:crypto');
const { billingControls } = require('./billing-controls');
const { CreditError } = require('./credit-policy');
const DEFAULT_SUBSCRIBER_DAILY_LIMIT = 10;
const MONTHLY_PRODUCT = 'ai_notes_pro_monthly_subscription';
const MONTHLY_ALLOWANCES = { trial: 60, monthly: 700 };

function monthlyAllowances(config) {
    return config.monthlySubscriptionAllowanceEnabled === true ? MONTHLY_ALLOWANCES : null;
}

function allowanceWindow(subscription, config) {
    const limits = monthlyAllowances(config);
    const period = subscription.allowancePeriod;
    if (!limits || subscription.productId !== MONTHLY_PRODUCT ||
        !subscription.transactionId || !['trial', 'monthly'].includes(period)) return null;
    const reset = new Date(subscription.expiresAt);
    if (!subscription.expiresAt || !Number.isFinite(reset.getTime()))
        throw new CreditError(503, 'Subscription period needs support review');
    return { period, limit: limits[period], reset, transactionId: subscription.transactionId };
}

function getSubscriberDailyLimit(config, user) {
    const limit = user?.subscriberDailyLimitOverride ?? config.subscriberDailyLimit ?? DEFAULT_SUBSCRIBER_DAILY_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000)
        throw new CreditError(503, 'Subscription limits are temporarily unavailable');
    return limit;
}

function dailySubscriptionUsage(user, config, now = new Date()) {
    const limit = getSubscriberDailyLimit(config, user);
    const start = new Date(now);
    start.setUTCHours(0, 0, 0, 0);
    const reset = new Date(start.getTime() + 86400000);
    const previous = user.lastRequestReset ? new Date(user.lastRequestReset) : null;
    const used = previous && previous >= start && previous < reset ? user.dailyRequestCount || 0 : 0;
    if (!Number.isSafeInteger(used) || used < 0)
        throw new CreditError(503, 'Subscription usage needs support review');
    return {
        billingControls: billingControls(config),
        subscriptionUsageKey: createHash('sha256').update(user.recoveryCode ? 'wallet:' + user.recoveryCode : 'apple:' + user._id).digest('hex'),
        subscriptionTrackingSource: 'primary',
        subscriberAllowancePeriod: 'daily',
        subscriberDailyUsage: used,
        subscriberDailyLimit: limit,
        subscriberDailyRemaining: Math.max(0, limit - used),
        subscriberResetAt: reset.toISOString(),
        serverTime: new Date(now).toISOString(),
    };
}
function subscriptionUsage(user, config, now = new Date()) {
    const window = allowanceWindow(user, config);
    if (!window) return dailySubscriptionUsage(user, config, now);
    const { period, limit, reset, transactionId } = window;
    const used = user.periodUsageTransactionId === transactionId ? user.periodRequestCount ?? 0 : 0;
    if (!Number.isSafeInteger(used) || used < 0)
        throw new CreditError(503, 'Subscription usage needs support review');
    return {
        billingControls: billingControls(config),
        subscriptionUsageKey: createHash('sha256').update('apple:' + user._id + ':' + transactionId).digest('hex'),
        subscriptionTrackingSource: 'primary',
        subscriberAllowancePeriod: period,
        subscriberDailyUsage: used,
        subscriberDailyLimit: limit,
        subscriberDailyRemaining: period === 'trial' && now >= reset ? 0 : Math.max(0, limit - used),
        subscriberResetAt: reset.toISOString(),
        serverTime: new Date(now).toISOString(),
    };
}

async function requestHistoryUsage(user, config, now = new Date(), session, requests) {
    if (billingControls(config).usePrimarySubscriptionTracking) return subscriptionUsage(user, config, now);
    const window = allowanceWindow(user, config);
    const usage = window
        ? subscriptionUsage({ ...user, periodRequestCount: 0 }, config, now)
        : dailySubscriptionUsage({ ...user, lastRequestReset: null }, config, now);
    const reset = new Date(usage.subscriberResetAt);
    const start = new Date(reset.getTime() - 86400000);
    const scope = user.recoveryCode
        ? { recoveryCode: user.recoveryCode, 'reservation.subscriptionId': { $exists: false } }
        : {
            'reservation.subscriptionId': String(user._id),
            'reservation.quotaEpoch': user.quotaEpoch ?? { $exists: false },
        };
    const model = requests || require('../models/GenerationRequest');
    const filter = {
        ...scope,
        'reservation.pro': true,
        ...(window
            ? { 'reservation.periodTransactionId': window.transactionId }
            : { 'reservation.day': { $gte: start.toISOString(), $lt: reset.toISOString() } }),
        $or: [
            { state: 'succeeded' },
            { state: 'pending', leaseUntil: { $gt: now } },
        ],
    };
    const query = model.aggregate([
        { $match: filter },
        { $group: { _id: null, used: { $sum: { $ifNull: ['$reservation.proUnits', 1] } } } },
    ]);
    if (session) query.session(session);
    const [total] = await query;
    const used = total?.used ?? 0;
    return {
        ...usage,
        subscriptionTrackingSource: 'requestHistory',
        subscriberDailyUsage: used,
        subscriberDailyRemaining: window?.period === 'trial' && now >= window.reset
            ? 0 : Math.max(0, usage.subscriberDailyLimit - used),
    };
}
module.exports = {
    requestHistoryUsage, subscriptionUsage, dailySubscriptionUsage, monthlyAllowances,
    getSubscriberDailyLimit, DEFAULT_SUBSCRIBER_DAILY_LIMIT, MONTHLY_PRODUCT,
};
