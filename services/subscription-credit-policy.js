const { createHash } = require('node:crypto');
const { CreditError } = require('./credit-policy');
const { subscriptionAllowances } = require('./subscription-usage');

// Phase 1 introduces accounting only. Activation and renewal handling follow in
// Phase 2; an absent setting must not silently enable rollover in production.
const DEFAULT_ROLLOVER = Object.freeze({ monthlyEnabled: false, maxCarryPeriods: 1 });
function rolloverControls(config) {
    const value = config?.subscriptionRollover;
    if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value)))
        throw new CreditError(503, 'Subscription rollover settings need support review');
    const { monthlyEnabled = DEFAULT_ROLLOVER.monthlyEnabled,
        maxCarryPeriods = DEFAULT_ROLLOVER.maxCarryPeriods } = value ?? {};
    if (typeof monthlyEnabled !== 'boolean' || maxCarryPeriods !== 1)
        throw new CreditError(503, 'Subscription rollover must be limited to one additional paid period');
    return { monthlyEnabled, maxCarryPeriods };
}

async function initializeSubscriptionRollover(Config) {
    await Config.collection.updateOne(
        { key: 'master_config', subscriptionRollover: { $exists: false } },
        { $set: { subscriptionRollover: DEFAULT_ROLLOVER } },
    );
}

function snapshotSubscriptionPolicy(config = {}, kind, existingLimit) {
    if (!['monthly', 'weekly', 'trial'].includes(kind))
        throw new CreditError(400, 'Invalid subscription allocation kind');
    if (config?.dailySubscriptionAllowanceEnabled === true && kind !== 'trial')
        throw new CreditError(409, 'Daily allowances cannot use period credit allocations');
    const controls = rolloverControls(config);
    const grantedCredits = existingLimit ?? subscriptionAllowances(config)[kind];
    if (!Number.isSafeInteger(grantedCredits) || grantedCredits < 0 || grantedCredits > 10000)
        throw new CreditError(503, 'Subscription grant needs support review');
    const terms = {
        version: 1, kind, grantedCredits,
        rolloverEligible: kind === 'monthly' && controls.monthlyEnabled,
        maxCarryPeriods: controls.maxCarryPeriods,
    };
    return Object.freeze({ ...terms,
        policyId: createHash('sha256').update(JSON.stringify(terms)).digest('hex'),
    });
}
module.exports = { DEFAULT_ROLLOVER, initializeSubscriptionRollover, rolloverControls, snapshotSubscriptionPolicy };
