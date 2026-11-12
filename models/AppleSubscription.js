const mongoose = require('mongoose');
const schema = new mongoose.Schema(
    {
        _id: String,
        environment: {
            type: String,
            enum: ['Production', 'Sandbox'],
            required: true,
        },
        originalTransactionId: { type: String, required: true },
        transactionId: String,
        productId: String,
        purchaseDate: Date,
        expiresAt: Date,
        graceExpiresAt: Date,
        signedAt: Date,
        revokedAt: Date,
        revokedTransactions: { type: [String], default: [] },
        isUpgraded: { type: Boolean, default: false },
        migratedWallets: { type: [String], default: [] },
        subscriberDailyLimitOverride: {
            type: Number,
            min: 1,
            max: 10000,
            validate: Number.isSafeInteger,
        },
        dailyRequestCount: { type: Number, default: 0 },
        lastRequestReset: Date,
        lastEventAt: Date,
        expiredTransactionId: String,
    },
    { timestamps: true },
);
module.exports = mongoose.model('AppleSubscription', schema);
