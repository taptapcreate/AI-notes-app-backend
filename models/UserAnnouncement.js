const mongoose = require('mongoose');
const { randomUUID } = require('node:crypto');
const schema = new mongoose.Schema({
    recoveryCode: { type: String, required: true, unique: true, trim: true, uppercase: true, match: /^[A-Z0-9-]{6,80}$/ },
    id: { type: String, default: randomUUID, maxlength: 120 },
    active: { type: Boolean, default: false },
    title: { type: String, default: 'A message from AI Notes', maxlength: 120 },
    message: { type: String, default: '', maxlength: 2000 },
    displayMode: { type: String, enum: ['banner', 'popup'], default: 'banner' },
    platforms: { type: [{ type: String, enum: ['ios', 'android', 'macos'] }], default: [] },
    expiresAt: { type: Date, default: null },
}, { timestamps: true });
module.exports = mongoose.model('UserAnnouncement', schema, 'userannouncements');
