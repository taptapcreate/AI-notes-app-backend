const mongoose = require('mongoose');
// Separate recovery records; original users and applesubscriptions collections remain unchanged.
const schema = new mongoose.Schema({
    _id: String,
    kind: { type: String, enum: ['wallet', 'subscription'], required: true },
    identity: { type: String, required: true },
    snapshot: { type: mongoose.Schema.Types.Mixed, required: true },
    updatedAt: { type: Date, required: true },
}, { versionKey: false });
schema.index({ kind: 1, 'snapshot.deviceId': 1 });
module.exports = mongoose.model('AccountRecovery', schema, 'accountrecoveries');
