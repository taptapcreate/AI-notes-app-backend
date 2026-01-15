const mongoose = require('mongoose');

// User Schema for credit tracking
const UserSchema = new mongoose.Schema({
    recoveryCode: {
        type: String,
        required: true,
        unique: true,
        index: true,
    },
    credits: {
        type: Number,
        default: 0,
    },
    freeCreditsRemaining: {
        type: Number,
        default: 3, // Daily free credits
    },
    lastFreeCreditsReset: {
        type: Date,
        default: Date.now,
    },
    processedTransactions: [{
        transactionId: String,
        credits: Number,
        processedAt: { type: Date, default: Date.now },
    }],
    createdAt: {
        type: Date,
        default: Date.now,
    },
    lastActive: {
        type: Date,
        default: Date.now,
    },
});

// Generate random recovery code
UserSchema.statics.generateRecoveryCode = function () {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Exclude confusing chars like 0/O, 1/I
    let code = '';
    for (let i = 0; i < 8; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
};

// Check if transaction already processed
UserSchema.methods.hasProcessedTransaction = function (transactionId) {
    return this.processedTransactions.some(tx => tx.transactionId === transactionId);
};

// Reset daily free credits if new day
UserSchema.methods.resetDailyCreditsIfNeeded = function () {
    const now = new Date();
    const lastReset = new Date(this.lastFreeCreditsReset);

    // Check if it's a new day (different date)
    if (now.toDateString() !== lastReset.toDateString()) {
        this.freeCreditsRemaining = 3;
        this.lastFreeCreditsReset = now;
        return true;
    }
    return false;
};

module.exports = mongoose.model('User', UserSchema);
