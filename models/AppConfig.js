const mongoose = require('mongoose');
const { DEFAULT_WELCOME_CREDITS } = require('../services/credit-policy');

const PlatformReleaseSchema = new mongoose.Schema({
    minVersion: { type: String, match: /^\d+\.\d+\.\d+$/ },
    latestVersion: { type: String, match: /^\d+\.\d+\.\d+$/ },
    forceUpdate: { type: Boolean, default: false },
    storeUrl: String,
    releaseNotes: [{ type: String, maxlength: 500 }],
}, { _id: false });

const AppConfigSchema = new mongoose.Schema({
    key: {
        type: String,
        required: true,
        unique: true,
        default: 'master_config',
    },
    // 1. General Alerts
    globalAlert: {
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
    subscriberDailyLimit: { type: Number, default: 10, min: 1, max: 10000, validate: Number.isSafeInteger },
    // Enable only after the updated mobile builds are available. The cutover
    // script enables this together with the one-time allowance.
    generationBillingRequired: { type: Boolean, default: false },
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
    // 4. Version Control
    minAppVersion: { type: String, default: '1.0.0' },
    latestAppVersion: { type: String, default: '1.0.0' },
    updateUrl: { type: String, default: 'https://apps.apple.com/app/id...' },

    updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('AppConfig', AppConfigSchema);
