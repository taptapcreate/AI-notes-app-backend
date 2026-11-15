const { createHash } = require('node:crypto');
const { billingControls } = require('./billing-controls');
const { CreditError } = require('./credit-policy');
const DEFAULT_SUBSCRIBER_DAILY_LIMIT = 10;

function getSubscriberDailyLimit(config, user) {
    const limit = user?.subscriberDailyLimitOverride ?? config.subscriberDailyLimit ?? DEFAULT_SUBSCRIBER_DAILY_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000)
        throw new CreditError(503, 'Subscription limits are temporarily unavailable');
    return limit;
}

function subscriptionUsage(user, config, now = new Date()) {
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
        subscriberDailyUsage: used,
        subscriberDailyLimit: limit,
        subscriberDailyRemaining: Math.max(0, limit - used),
        subscriberResetAt: reset.toISOString(),
        serverTime: new Date(now).toISOString(),
    };
}
async function requestHistoryUsage(user, config, now = new Date(), session, requests) {
    if (billingControls(config).usePrimarySubscriptionTracking) return subscriptionUsage(user, config, now);
    const usage = subscriptionUsage({ ...user, dailyRequestCount: 0, lastRequestReset: null }, config, now);
    const reset = new Date(usage.subscriberResetAt);
    const start = new Date(reset.getTime() - 86400000);
    const scope = user.recoveryCode
        ? { recoveryCode: user.recoveryCode, 'reservation.subscriptionId': { $exists: false } }
        : {
            'reservation.subscriptionId': String(user._id),
            'reservation.quotaEpoch': user.quotaEpoch ?? { $exists: false },
        };
    const query = (requests || require('../models/GenerationRequest')).countDocuments({
        ...scope,
        'reservation.pro': true,
        'reservation.day': { $gte: start.toISOString(), $lt: reset.toISOString() },
        $or: [
            { state: 'succeeded' },
            { state: 'pending', leaseUntil: { $gt: now } },
        ],
    });
    if (session) query.session(session);
    const used = await query;
    return {
        ...usage,
        subscriptionTrackingSource: 'requestHistory',
        subscriberDailyUsage: used,
        subscriberDailyRemaining: Math.max(0, usage.subscriberDailyLimit - used),
    };
}
module.exports = { requestHistoryUsage, subscriptionUsage, getSubscriberDailyLimit, DEFAULT_SUBSCRIBER_DAILY_LIMIT };
