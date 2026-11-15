const mongoose = require('mongoose');
// The integration is intentionally opt-in; existing account models and routes are unchanged.
const schema = new mongoose.Schema({
    _id: String,
    kind: { type: String, enum: ['wallet', 'subscription'], required: true },
    identity: { type: String, required: true },
    snapshot: { type: mongoose.Schema.Types.Mixed, required: true },
    updatedAt: { type: Date, required: true },
}, { versionKey: false });
module.exports = mongoose.model('AccountRecovery', schema, 'accountrecoveries');
