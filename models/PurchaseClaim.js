const mongoose = require('mongoose');

// Ownership is reserved before crediting. Retrying after an interrupted request
// completes the same account's atomic grant instead of granting another account.
module.exports = mongoose.model(
    'PurchaseClaim',
    new mongoose.Schema({
        _id: String,
        recoveryCode: { type: String, required: true },
        createdAt: { type: Date, default: Date.now },
    }),
);
