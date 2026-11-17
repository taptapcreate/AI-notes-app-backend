const mongoose = require('mongoose');
const units = () => ({ type: Number, required: true, min: 0, max: 10000, validate: Number.isSafeInteger });
const schema = new mongoose.Schema({
    _id: { type: String, required: true },
    accountId: { type: String, required: true, immutable: true },
    transactionId: { type: String, required: true, maxlength: 512, immutable: true },
    kind: { type: String, enum: ['monthly', 'weekly', 'trial'], required: true, immutable: true },
    periodStart: { type: Date, required: true, immutable: true },
    periodEnd: { type: Date, required: true, immutable: true },
    expiresAt: { type: Date, required: true },
    carriedIntoTransactionId: String,
    carriedCredits: { ...units(), required: false },
    closedAt: Date,
    terms: { type: new mongoose.Schema({
        version: { type: Number, enum: [1], required: true },
        kind: { type: String, enum: ['monthly', 'weekly', 'trial'], required: true },
        grantedCredits: units(),
        rolloverEligible: { type: Boolean, required: true },
        maxCarryPeriods: { type: Number, enum: [1], required: true },
        policyId: { type: String, required: true },
    }, { _id: false }), required: true, immutable: true },
    available: units(),
    reserved: units(),
    spent: units(),
    expired: units(),
    revoked: units(),
}, { timestamps: true, versionKey: false });
schema.index({ accountId: 1, transactionId: 1 }, { unique: true });
schema.index({ accountId: 1, expiresAt: 1 });
schema.pre('validate', function () {
    const values = [this.available, this.reserved, this.spent, this.expired, this.revoked];
    if (values.every(Number.isSafeInteger) && values.reduce((a, b) => a + b, 0) !== this.terms?.grantedCredits)
        this.invalidate('available', 'Allocation units must equal the original grant');
    if (this.periodEnd <= this.periodStart || this.expiresAt < this.periodEnd)
        this.invalidate('periodEnd', 'Invalid subscription allocation dates');
    if (this.terms && (this.terms.kind !== this.kind ||
        (this.kind !== 'monthly' && this.terms.rolloverEligible)))
        this.invalidate('terms', 'Only paid monthly allocations may roll over');
    if (this.expiresAt > this.periodEnd && (!this.carriedIntoTransactionId || !this.terms?.rolloverEligible))
        this.invalidate('expiresAt', 'Only a recorded monthly carry may extend the original expiration');
    if (this.carriedIntoTransactionId &&
        (this.carriedIntoTransactionId === this.transactionId || this.expiresAt <= this.periodEnd))
        this.invalidate('carriedIntoTransactionId', 'A carry requires a later transaction and expiration');
});
module.exports = mongoose.model('SubscriptionCreditAllocation', schema, 'subscriptioncreditallocations');
