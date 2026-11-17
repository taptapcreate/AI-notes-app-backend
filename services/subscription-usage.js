const { createHash } = require('node:crypto');
const { billingControls } = require('./billing-controls');
const { CreditError } = require('./credit-policy');
const DEFAULT_SUBSCRIBER_DAILY_LIMIT = 10;
const MONTHLY_PRODUCT = 'ai_notes_pro_monthly_subscription';
const WEEKLY_PRODUCT = 'ai_notes_pro_weekly_subscription';
const WEEKS_PER_MONTHLY_ALLOWANCE = 4;
const DEFAULT_MONTHLY_SUBSCRIPTION_CREDITS = 600;
const DEFAULT_FREE_TRIAL_CREDITS = 3;
const DEFAULT_SUBSCRIPTION_MESSAGES = {
    daily: 'Up to {credits} AI credits per day. Resets at midnight UTC.',
    weekly: '{credits} AI credits per paid billing week.',
    monthly: '{credits} AI credits per paid billing month.',
    trial: 'Eligible customers get a {duration} free trial with Pro features and {credits} extra AI credits total. Unused trial credits expire when it ends.',
    trialWithoutCredits: 'Eligible customers get a {duration} free trial with Pro features. The trial adds no extra credits. Your existing credits can be used during the trial.',
};

async function initializeSubscriptionControls(Config) {
    const fields = {
        dailySubscriptionAllowanceEnabled: false,
        monthlySubscriptionCredits: DEFAULT_MONTHLY_SUBSCRIPTION_CREDITS,
        freeTrialCreditsEnabled: true,
        freeTrialCredits: DEFAULT_FREE_TRIAL_CREDITS,
        subscriptionMessages: DEFAULT_SUBSCRIPTION_MESSAGES,
    };
    await Config.collection.bulkWrite(
        Object.entries(fields).map(([field, value]) => ({
            updateOne: {
                filter: { key: 'master_config', [field]: { $exists: false } },
                update: { $set: { [field]: value } },
            },
        })),
    );
    await Config.collection.updateOne(
        { key: 'master_config', 'subscriptionMessages.weekly': { $exists: false } },
        { $set: { 'subscriptionMessages.weekly': DEFAULT_SUBSCRIPTION_MESSAGES.weekly } },
    );
}

function configuredCreditLimit(value, fallback, minimum) {
    const limit = value ?? fallback;
    if (!Number.isSafeInteger(limit) || limit < minimum || limit > 10000)
        throw new CreditError(503, 'Subscription limits are temporarily unavailable');
    return limit;
}

function configuredMonthlyLimit(config) {
    return configuredCreditLimit(config.monthlySubscriptionCredits, DEFAULT_MONTHLY_SUBSCRIPTION_CREDITS, 1);
}

function getWeeklySubscriptionCredits(config) {
    return Math.floor(configuredMonthlyLimit(config) / WEEKS_PER_MONTHLY_ALLOWANCE);
}

async function syncWeeklySubscriptionCredits(Config, config) {
    const expected = getWeeklySubscriptionCredits(config);
    if (config.weeklySubscriptionCredits === expected) return;
    // Calculate from the current stored value, even if Compass edited it after this read.
    // Use the same snapshot for both updating the mirror and serving this request.
    const updated = await Config.findOneAndUpdate(
        { _id: config._id },
        [{ $set: { weeklySubscriptionCredits: { $floor: { $divide: [
            { $ifNull: ['$monthlySubscriptionCredits', DEFAULT_MONTHLY_SUBSCRIPTION_CREDITS] },
            WEEKS_PER_MONTHLY_ALLOWANCE,
        ] } } } }],
        { returnDocument: 'after', updatePipeline: true },
    );
    if (!updated) throw new CreditError(503, 'Subscription settings are temporarily unavailable');
    return updated;
}

function subscriptionAllowances(config) {
    const daily = config.dailySubscriptionAllowanceEnabled === true;
    return {
        monthly: daily ? null : configuredMonthlyLimit(config),
        weekly: daily ? null : getWeeklySubscriptionCredits(config),
        trial: config.freeTrialCreditsEnabled === false ? 0 :
            configuredCreditLimit(config.freeTrialCredits, DEFAULT_FREE_TRIAL_CREDITS, 0),
    };
}

function subscriptionPlanMessages(config) {
    const { monthly, weekly, trial } = subscriptionAllowances(config);
    const daily = getSubscriberDailyLimit(config);
    const messages = config.subscriptionMessages;
    const format = (template, fallback, credits) =>
        (template?.trim() || fallback).replaceAll('{credits}', String(credits));
    const dailyMessage = format(messages?.daily, DEFAULT_SUBSCRIPTION_MESSAGES.daily, daily);
    return {
        daily: dailyMessage,
        weekly: weekly === null ? dailyMessage :
            format(messages?.weekly, DEFAULT_SUBSCRIPTION_MESSAGES.weekly, weekly),
        monthly: monthly === null ? dailyMessage :
            format(messages?.monthly, DEFAULT_SUBSCRIPTION_MESSAGES.monthly, monthly),
        trial: trial > 0
            ? format(messages?.trial, DEFAULT_SUBSCRIPTION_MESSAGES.trial, trial)
            : format(messages?.trialWithoutCredits, DEFAULT_SUBSCRIPTION_MESSAGES.trialWithoutCredits, 0),
    };
}

function paidAllowancePeriod(productId) {
    return productId === MONTHLY_PRODUCT ? 'monthly' : productId === WEEKLY_PRODUCT ? 'weekly' : null;
}

function allowanceWindow(subscription, config) {
    const paidPeriod = paidAllowancePeriod(subscription.productId);
    if (!paidPeriod) return null;
    if (subscription.allowancePeriod === paidPeriod && config.dailySubscriptionAllowanceEnabled === true)
        return null;
    if (!subscription.transactionId || !['trial', paidPeriod].includes(subscription.allowancePeriod)) {
        const reset = new Date(subscription.expiresAt);
        if (!subscription.expiresAt || !Number.isFinite(reset.getTime()))
            throw new CreditError(503, 'Subscription period needs support review');
        // Wait for verified period data before granting a trial or paid allowance.
        return { period: paidPeriod, limit: 0, reset, transactionId: subscription.transactionId || null };
    }
    const limits = subscriptionAllowances(config);
    const period = subscription.allowancePeriod;
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
    const window = allowanceWindow(user, config);
    if (billingControls(config).usePrimarySubscriptionTracking || (window && !window.transactionId))
        return subscriptionUsage(user, config, now);
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
    requestHistoryUsage, subscriptionUsage, dailySubscriptionUsage, subscriptionAllowances,
    getWeeklySubscriptionCredits, syncWeeklySubscriptionCredits, paidAllowancePeriod,
    getSubscriberDailyLimit, subscriptionPlanMessages, initializeSubscriptionControls, DEFAULT_SUBSCRIBER_DAILY_LIMIT,
    DEFAULT_MONTHLY_SUBSCRIPTION_CREDITS, DEFAULT_FREE_TRIAL_CREDITS, MONTHLY_PRODUCT, WEEKLY_PRODUCT,
};
