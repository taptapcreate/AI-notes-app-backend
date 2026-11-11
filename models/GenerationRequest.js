const mongoose = require('mongoose');

const schema = new mongoose.Schema({
    _id: String,
    recoveryCode: { type: String, required: true, index: true },
    requestId: { type: String, required: true },
    endpoint: { type: String, required: true },
    bodyHash: { type: String, required: true },
    state: {
        type: String,
        enum: ['pending', 'succeeded', 'failed'],
        required: true,
    },
    reservation: { type: mongoose.Schema.Types.Mixed, required: true },
    leaseUntil: { type: Date, required: true },
    result: mongoose.Schema.Types.Mixed,
    httpStatus: Number,
    createdAt: { type: Date, default: Date.now },
    expiresAt: Date,
});
schema.index({ state: 1, leaseUntil: 1 });
// Retain the small idempotency record after purging result content. Deleting
// the whole record would let a very late retry charge the same request again.
schema.index({ expiresAt: 1 }, { sparse: true });
module.exports = mongoose.model('GenerationRequest', schema);
