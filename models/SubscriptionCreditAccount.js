const mongoose = require('mongoose');
// The store's verified subscription chain owns the balance, not a device or
// recovery code. iPhone and Mac transactions use the same "apple" namespace.
const schema = new mongoose.Schema({
    _id: { type: String, required: true },
    store: { type: String, enum: ['apple', 'google'], required: true, immutable: true },
    environment: { type: String, enum: ['Production', 'Sandbox'], required: true, immutable: true },
    chainId: { type: String, required: true, maxlength: 512, immutable: true },
    currentAllocationId: { type: String, required: true },
}, { timestamps: true, versionKey: false });
schema.index({ store: 1, environment: 1, chainId: 1 }, { unique: true });
module.exports = mongoose.model('SubscriptionCreditAccount', schema, 'subscriptioncreditaccounts');
