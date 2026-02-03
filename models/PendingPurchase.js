const mongoose = require('mongoose');

/**
 * Pending Purchase Schema
 * Stores purchases from RevenueCat webhooks that couldn't be matched to a user
 * These can be manually linked later via admin endpoint
 */
const PendingPurchaseSchema = new mongoose.Schema({
    // RevenueCat anonymous or unknown user ID
    rcAppUserId: {
        type: String,
        required: true,
        index: true,
    },
    // Product that was purchased
    productId: {
        type: String,
        required: true,
    },
    // Transaction ID (for idempotency)
    transactionId: {
        type: String,
        required: true,
        unique: true,
    },
    // Credits this purchase should grant
    credits: {
        type: Number,
        required: true,
    },
    // Status: pending, processed, or expired
    status: {
        type: String,
        enum: ['pending', 'processed', 'expired'],
        default: 'pending',
    },
    // If processed, which recovery code received the credits
    linkedRecoveryCode: {
        type: String,
        default: null,
    },
    // Raw webhook event data for debugging
    rawEvent: {
        type: Object,
    },
    // Timestamps
    createdAt: {
        type: Date,
        default: Date.now,
    },
    processedAt: {
        type: Date,
        default: null,
    },
});

module.exports = mongoose.model('PendingPurchase', PendingPurchaseSchema);
