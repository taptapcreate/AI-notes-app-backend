const mongoose = require('mongoose');
const { randomUUID } = require('node:crypto');
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
        quotaEpoch: { type: String, default: randomUUID },
        dailyRequestCount: { type: Number, default: 0 },
        lastRequestReset: Date,
        allowancePeriod: { type: String, enum: ['trial', 'monthly', 'weekly'] },
        trialCreditLimit: { type: Number, min: 0, max: 10000, validate: Number.isSafeInteger },
        periodUsageTransactionId: String,
        periodRequestCount: { type: Number, min: 0, default: 0, validate: Number.isSafeInteger },
        lastEventAt: Date,
        expiredTransactionId: String,
        scheduledRenewal: new mongoose.Schema({
            transactionId: String, productId: String, purchaseDate: Date,
            expiresAt: Date, allowancePeriod: String,
        }, { _id: false }),
    },
    { timestamps: true },
);
module.exports = mongoose.model('AppleSubscription', schema);
