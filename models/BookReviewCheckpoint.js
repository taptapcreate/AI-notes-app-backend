const mongoose = require('mongoose');

// Temporary generated edits only: no manuscript snapshot, prompts or recovery code.
const schema = new mongoose.Schema({
    _id: String,
    generationId: { type: String, required: true },
    token: { type: String, required: true },
    leaseUntil: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    attemptWindowEndsAt: Date,
    invalid: { type: Boolean, default: false },
    chunks: { type: [mongoose.Schema.Types.Mixed], default: [] },
    attempts: { type: [Number], default: [] },
});
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
module.exports = mongoose.model('BookReviewCheckpoint', schema);
