const mongoose = require('mongoose');

// A separate unique key avoids imposing a new unique deviceId index on legacy users.
// Only a hash of the provided device identity is retained in this registry.
const schema = new mongoose.Schema({
    _id: String,
    recoveryCode: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('CreditRegistration', schema);
