const mongoose = require('mongoose');

const schema = new mongoose.Schema({
    _id: String,
    recoveryCode: { type: String, required: true, index: true },
    requestId: { type: String, required: true },
    endpoint: { type: String, required: true },
    bodyHash: { type: String, required: true },
    contentHash: { type: String },
    state: {
        type: String,
        enum: ['pending', 'succeeded', 'unchanged', 'failed'],
        required: true,
    },
    reservation: { type: mongoose.Schema.Types.Mixed, required: true },
    leaseUntil: { type: Date, required: true },
    result: mongoose.Schema.Types.Mixed,
    httpStatus: Number,
    observability: { type: mongoose.Schema.Types.Mixed },
    createdAt: { type: Date, default: Date.now },
    expiresAt: Date,
});
schema.index({ state: 1, leaseUntil: 1 });
schema.index({ recoveryCode: 1, state: 1, createdAt: 1 });
schema.index({ recoveryCode: 1, endpoint: 1, contentHash: 1, state: 1, createdAt: -1 }, { sparse: true });
schema.index({ state: 1, createdAt: 1 });
schema.index({ 'reservation.subscriptionId': 1, 'reservation.quotaEpoch': 1, 'reservation.day': 1, state: 1 });
schema.index({ recoveryCode: 1, 'reservation.day': 1, state: 1 });
schema.index({ 'reservation.subscriptionId': 1, 'reservation.quotaEpoch': 1, 'reservation.periodTransactionId': 1, state: 1 }, {
    partialFilterExpression: { 'reservation.periodTransactionId': { $exists: true } },
});
// Retain the small idempotency record after purging result content. Deleting
// the whole record would let a very late retry charge the same request again.
schema.index({ expiresAt: 1 }, { sparse: true });
module.exports = mongoose.model('GenerationRequest', schema);
