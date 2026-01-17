const mongoose = require('mongoose');

const AppConfigSchema = new mongoose.Schema({
    key: {
        type: String,
        required: true,
        unique: true,
        default: 'master_config'
    },
    // 1. General Alerts
    globalAlert: {
        active: { type: Boolean, default: false },
        title: { type: String, default: 'Announcement' },
        message: { type: String, default: '' },
        isBlocking: { type: Boolean, default: false }, // Force update or maintenance
    },
    // 1.5 Free Limits
    freeDailyCredits: { type: Number, default: 3 },
    // 2. Subscription Promo (Home Screen)
    subscriptionOffer: {
        active: { type: Boolean, default: false },
        title: { type: String, default: 'Special Offer' },
        message: { type: String, default: '' },
        discountPercent: { type: Number, default: 0 },
        promoCode: { type: String, default: '' }
    },
    // 3. Ad Rewards
    adRewards: {
        active: { type: Boolean, default: true }, // Master toggle for Watch Ads feature
        standardReward: { type: Number, default: 1 },
        specialOfferActive: { type: Boolean, default: false },
        specialReward: { type: Number, default: 3 },
        specialMessage: { type: String, default: 'Special Offer! Watch an ad to earn 3 credits!' }
    },
    // 4. Version Control
    minAppVersion: { type: String, default: '1.0.0' },
    latestAppVersion: { type: String, default: '1.0.0' },
    updateUrl: { type: String, default: 'https://apps.apple.com/app/id...' },

    updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('AppConfig', AppConfigSchema);
