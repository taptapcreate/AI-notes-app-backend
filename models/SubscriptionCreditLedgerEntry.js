const mongoose = require('mongoose');
const schema = new mongoose.Schema({
    _id: { type: String, required: true },
    accountId: { type: String, required: true, immutable: true },
    operationId: { type: String, required: true, maxlength: 512, immutable: true },
    type: { type: String, enum: ['grant', 'reserve', 'consume', 'release', 'expire', 'carry', 'revoke', 'import'], required: true, immutable: true },
    units: { type: Number, required: true, min: 0, max: 20000, validate: Number.isSafeInteger, immutable: true },
    allocations: { type: [{
        _id: false,
        allocationId: { type: String, required: true },
        units: { type: Number, required: true, min: 1, max: 10000, validate: Number.isSafeInteger },
    }], required: true, immutable: true },
    createdAt: { type: Date, required: true, immutable: true },
}, { versionKey: false });
schema.pre('validate', function () {
    const allocated = this.allocations.reduce((total, item) => total + item.units, 0);
    if (allocated !== this.units)
        this.invalidate('units', 'Ledger units must match the allocation breakdown');
});
schema.index({ accountId: 1, operationId: 1 }, { unique: true });
schema.index({ accountId: 1, createdAt: 1 });
module.exports = mongoose.model('SubscriptionCreditLedgerEntry', schema, 'subscriptioncreditledger');
