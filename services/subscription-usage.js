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
        subscriberDailyUsage: used,
        subscriberDailyLimit: limit,
        subscriberDailyRemaining: Math.max(0, limit - used),
        subscriberResetAt: reset.toISOString(),
        serverTime: new Date(now).toISOString(),
    };
}
module.exports = { subscriptionUsage, getSubscriberDailyLimit, DEFAULT_SUBSCRIBER_DAILY_LIMIT };
