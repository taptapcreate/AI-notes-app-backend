const mongoose = require('mongoose');
const { IDS, PLATFORMS } = require('../services/credit-pack-catalog');
const Credits = new mongoose.Schema(Object.fromEntries(IDS.map(id => [id, {
    type: Number, required: true, min: 1, max: 100000, validate: Number.isSafeInteger,
}])), { _id: false });
const Revision = new mongoose.Schema({
    effectiveAt: { type: Date, required: true }, hash: { type: String, required: true },
    credits: { type: Credits, required: true },
}, { _id: false });
module.exports = mongoose.model('CreditPackHistory', new mongoose.Schema({
    _id: { type: String, enum: ['apple', 'android', 'windows'] }, version: { type: Number, required: true },
    revisions: { type: [Revision], required: true },
}));
