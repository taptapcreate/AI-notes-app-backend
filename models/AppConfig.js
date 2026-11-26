const mongoose = require('mongoose');
const { limits: noteOutputLimits, minimum: minimumNoteOutputTokens } = require('../services/note-output-limits');
const { DEFAULT_WELCOME_CREDITS } = require('../services/credit-policy');
const { DEFAULT_SUBSCRIBER_DAILY_LIMIT, DEFAULT_MONTHLY_SUBSCRIPTION_CREDITS, DEFAULT_FREE_TRIAL_CREDITS } = require('../services/subscription-usage');
const { DEFAULT_ROLLOVER } = require('../services/subscription-credit-policy');
const { DEFAULT_FEEDBACK_MESSAGE } = require('../services/feature-beta');

const FeatureBetaEntrySchema = new mongoose.Schema(
    {
        beta: { type: Boolean, default: false },
        showFeedbackMessage: { type: Boolean, default: false },
        feedbackMessage: { type: String, trim: true, maxlength: 500, default: DEFAULT_FEEDBACK_MESSAGE },
    },
    { _id: false },
);

const PlatformReleaseSchema = new mongoose.Schema({
    minVersion: { type: String, match: /^\d+\.\d+\.\d+$/ },
    latestVersion: { type: String, match: /^\d+\.\d+\.\d+$/ },
    forceUpdate: { type: Boolean, default: false },
    storeUrl: String,
    releaseNotes: [{ type: String, maxlength: 500 }],
}, { _id: false });

const PlatformBillingSchema = new mongoose.Schema({
    showSubscriptions: { type: Boolean, default: true },
    showTopUpPacks: { type: Boolean, default: true },
}, { _id: false });

const AppConfigSchema = new mongoose.Schema({
    // Public Help & FAQ support card. Operators can change it without releasing a desktop build.
    helpSupport: {
        type: new mongoose.Schema({
            enabled: { type: Boolean, default: false },
            title: { type: String, trim: true, maxlength: 80 },
            message: { type: String, trim: true, maxlength: 600 },
            buttonLabel: { type: String, trim: true, maxlength: 40 },
            url: { type: String, trim: true, maxlength: 2048 },
        }, { _id: false }),
        default: undefined,
    },
    // Public consent copy only; changing these fields does not change AI routing or retention.
    processingDisclosure: {
        type: new mongoose.Schema({
            providers: { type: [{ type: String, trim: true, maxlength: 40 }], default: undefined },
            cloudPdfProviders: { type: [{ type: String, trim: true, maxlength: 40 }], default: undefined },
            recoveryMessage: { type: String, trim: true, maxlength: 140 },
            details: { type: String, trim: true, maxlength: 180 },
        }, { _id: false }),
        default: undefined,
    },
    key: {
        type: String,
        required: true,
        unique: true,
        default: 'master_config',
    },
    maintenance: { type: new mongoose.Schema({
        platforms: { type: new mongoose.Schema(Object.fromEntries(
            ['ios', 'android', 'macos'].map(platform => [platform, {
                type: new mongoose.Schema({
                    enabled: { type: Boolean, default: false },
                    title: { type: String, maxlength: 120 },
                    message: { type: String, maxlength: 2000 },
                }, { _id: false }), default: () => ({}),
            }]),
        ), { _id: false }), default: () => ({}) },
        enabled: { type: Boolean, default: false },
        title: { type: String, maxlength: 120, default: 'We’ll be back soon' },
        message: { type: String, maxlength: 2000, default: 'AI Notes is undergoing maintenance. Please try again shortly.' },
    }, { _id: false }), default: undefined },
    billingControls: {
        type: new mongoose.Schema({
            showSubscriptions: { type: Boolean, default: true },
            showTopUpPacks: { type: Boolean, default: true },
            usePrimarySubscriptionTracking: { type: Boolean, default: true },
        }, { _id: false }),
        default: () => ({}),
    },
    // These switches narrow global purchase visibility; they never override a global false.
    platformBillingControls: {
        type: new mongoose.Schema(Object.fromEntries(
            ['ios', 'android', 'macos', 'windows'].map(platform =>
                [platform, { type: PlatformBillingSchema, default: () => ({}) }]),
        ), { _id: false }),
        default: () => ({}),
    },
    // Changing these amounts activates a new catalog revision automatically.
    // Missing platform fields inherit the common amounts. Empty settings use server defaults.
    creditPacks: {
        amounts: { type: new mongoose.Schema(Object.fromEntries(
            require('../services/credit-pack-catalog').IDS.map(id => [id, {
                type: Number, min: 1, max: 100000, validate: Number.isSafeInteger,
            }]),
        ), { _id: false }), default: undefined },
        platforms: { type: new mongoose.Schema(Object.fromEntries(
            ['android', 'windows'].map(platform => [platform, {
                type: new mongoose.Schema(Object.fromEntries(
                    require('../services/credit-pack-catalog').IDS.map(id => [id, {
                        type: Number, min: 1, max: 100000, validate: Number.isSafeInteger,
                    }]),
                ), { _id: false }), default: undefined,
            }]),
        ), { _id: false }), default: undefined },
    },
    noteOutputTokenLimits: {
        type: new mongoose.Schema(Object.fromEntries(Object.entries(noteOutputLimits).map(([key, rule]) => [
            key, { type: Number, default: rule.default, min: minimumNoteOutputTokens, max: rule.cap, validate: Number.isSafeInteger },
        ])), { _id: false }),
        default: () => ({}),
    },
    // 1. General Alerts
    globalAlert: {
        id: { type: String, maxlength: 120 },
        displayMode: { type: String, enum: ['popup', 'banner'], default: 'popup' },
        active: { type: Boolean, default: false },
        title: { type: String, default: 'Announcement' },
        message: { type: String, default: '' },
        isBlocking: { type: Boolean, default: false }, // Force update or maintenance
    },
    // 1.2 "Kill Switch" for Daily Credits
    dailyFreeCreditsEnabled: { type: Boolean, default: false },

    // 1.5 Free Limits
    freeDailyCredits: { type: Number, default: 3 },
    welcomePackCredits: {
        type: Number,
        default: DEFAULT_WELCOME_CREDITS,
        min: 0,
        max: 10000,
        validate: {
            validator: Number.isSafeInteger,
            message: 'Welcome credits must be a whole number',
        },
    },
    welcomePackVersion: { type: Number, default: 1 },
    subscriberDailyLimit: { type: Number, default: DEFAULT_SUBSCRIBER_DAILY_LIMIT, min: 1, max: 10000, validate: Number.isSafeInteger },
    dailySubscriptionAllowanceEnabled: { type: Boolean, default: false },
    monthlySubscriptionCredits: { type: Number, default: DEFAULT_MONTHLY_SUBSCRIPTION_CREDITS, min: 1, max: 10000, validate: Number.isSafeInteger },
    subscriptionRollover: {
        type: new mongoose.Schema({
            monthlyEnabled: { type: Boolean, default: DEFAULT_ROLLOVER.monthlyEnabled },
            maxCarryPeriods: { type: Number, enum: [1], default: DEFAULT_ROLLOVER.maxCarryPeriods },
        }, { _id: false }),
        default: () => ({}),
    },
    // Derived from monthlySubscriptionCredits; edit the monthly value to change both.
    weeklySubscriptionCredits: { type: Number, min: 0, max: 2500, validate: Number.isSafeInteger },
    freeTrialCreditsEnabled: { type: Boolean, default: true },
    freeTrialCredits: { type: Number, default: DEFAULT_FREE_TRIAL_CREDITS, min: 0, max: 10000, validate: Number.isSafeInteger },
    subscriptionMessages: {
        daily: { type: String, trim: true, maxlength: 500 },
        monthly: { type: String, trim: true, maxlength: 500 },
        weekly: { type: String, trim: true, maxlength: 500 },
        trial: { type: String, trim: true, maxlength: 500 },
        trialWithoutCredits: { type: String, trim: true, maxlength: 500 },
    },
    // Enable only after the updated mobile builds are available. The cutover
    // script enables this together with the one-time allowance.
    generationBillingRequired: { type: Boolean, default: true },
    generationMediaPricing: {
        audioExtra: { type: Number, min: 1, max: 5, validate: Number.isSafeInteger },
        audioLongExtra: { type: Number, min: 2, max: 6, validate: Number.isSafeInteger },
        narrationExtra: { type: Number, min: 1, max: 5, validate: Number.isSafeInteger },
        pdfPagesPerCredit: { type: Number, min: 1, max: 10, validate: Number.isSafeInteger },
    },
    // 2. Subscription Promo (Home Screen)
    subscriptionOffer: {
        active: { type: Boolean, default: false },
        title: { type: String, default: 'Special Offer' },
        message: { type: String, default: '' },
        discountPercent: { type: Number, default: 0 },
        promoCode: { type: String, default: '' },
    },
    // 3. Ad Rewards
    adRewards: {
        enabled: { type: Boolean, default: false }, // Whether to show the ad section and rewards at all
        active: { type: Boolean, default: false }, // Whether the feature is currently operational (shows message if false)
        standardReward: { type: Number, default: 1 },
        specialOfferActive: { type: Boolean, default: false },
        specialReward: { type: Number, default: 3 },
        specialMessage: { type: String, default: 'Special Offer! Watch an ad to earn 3 credits!' },
    },
    ios: { type: PlatformReleaseSchema, default: undefined },
    android: { type: PlatformReleaseSchema, default: undefined },
    macos: { type: PlatformReleaseSchema, default: undefined },
    featureBeta: {
        smartNotes: { type: FeatureBetaEntrySchema, default: () => ({}) },
        smartReply: { type: FeatureBetaEntrySchema, default: () => ({}) },
        bookStudio: { type: FeatureBetaEntrySchema, default: () => ({}) },
    },
    // 4. Version Control
    minAppVersion: { type: String, default: '1.0.0' },
    latestAppVersion: { type: String, default: '1.0.0' },
    updateUrl: { type: String, default: 'https://apps.apple.com/app/id...' },

    updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('AppConfig', AppConfigSchema);
