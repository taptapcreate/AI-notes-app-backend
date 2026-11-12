const DEFAULT_WELCOME_CREDITS = 7;

class CreditError extends Error {
    constructor(status, message, details = {}) {
        super(message);
        this.status = status;
        this.details = details;
    }
}

function recoveryCode(value) {
    if (typeof value !== 'string' || !/^[A-Z0-9-]{6,80}$/i.test(value.trim())) {
        throw new CreditError(400, 'A valid recovery code is required');
    }
    return value.trim().toUpperCase();
}

function positiveAmount(value) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 10000) {
        throw new CreditError(400, 'Amount must be a positive integer of at most 10000');
    }
    return value;
}

function getWelcomeCredits(config) {
    const amount =
        config?.welcomePackCredits === undefined
            ? DEFAULT_WELCOME_CREDITS
            : config.welcomePackCredits;
    if (!Number.isSafeInteger(amount) || amount < 0 || amount > 10000) {
        throw new CreditError(503, 'Welcome credits must be an integer between 0 and 10000');
    }
    return amount;
}

function policy(config) {
    // Configuration errors must never silently turn daily grants back on.
    if (!config || typeof config.dailyFreeCreditsEnabled !== 'boolean') {
        throw new CreditError(503, 'Credit configuration is temporarily unavailable');
    }
    if (
        config.dailyFreeCreditsEnabled &&
        (!Number.isSafeInteger(config.freeDailyCredits) ||
            config.freeDailyCredits < 0 ||
            config.freeDailyCredits > 10000)
    ) {
        throw new CreditError(503, 'Credit configuration is temporarily unavailable');
    }
    return {
        daily: config.dailyFreeCreditsEnabled,
        field: config.dailyFreeCreditsEnabled ? 'freeCreditsRemaining' : 'totalFreeCredits',
        dailyLimit: config.freeDailyCredits,
        welcomeCredits: getWelcomeCredits(config),
    };
}

function balance(user, creditPolicy) {
    const amount = (field) => {
        const value = user[field] ?? 0;
        if (!Number.isSafeInteger(value) || value < 0) {
            throw new CreditError(503, 'This credit balance needs support review');
        }
        return value;
    };
    const credits = amount('credits');
    const adCredits = amount('adCredits');
    const freeCreditsRemaining = amount(creditPolicy.field);
    const totalAvailable = credits + adCredits + freeCreditsRemaining;
    if (!Number.isSafeInteger(totalAvailable))
        throw new CreditError(503, 'This credit balance needs support review');
    return {
        success: true,
        credits,
        adCredits,
        freeCreditsRemaining,
        totalAvailable,
        userServerVersion: user.welcomePackVersion || 0,
        dailyFreeCreditsEnabled: creditPolicy.daily,
        freeCreditPolicy: creditPolicy.daily ? 'daily' : 'one-time',
        welcomePackCredits: creditPolicy.welcomeCredits,
        generationBillingVersion: 2,
    };
}

module.exports = {
    DEFAULT_WELCOME_CREDITS,
    getWelcomeCredits,
    CreditError,
    recoveryCode,
    positiveAmount,
    policy,
    balance,
};
