const { createHash } = require('node:crypto');
const { CreditError, recoveryCode } = require('./credit-policy');
function createUserAnnouncements({ Messages, credits, now = () => new Date() }) {
    return async (authorization, platform) => {
        if (typeof authorization !== 'string' || !authorization.startsWith('Bearer '))
            throw new CreditError(401, 'Your account authentication is required');
        let code;
        try { code = recoveryCode(authorization.slice(7)); }
        catch { throw new CreditError(401, 'Your account authentication is required'); }
        await credits.byCode(code);
        const record = await Messages.findOne({ recoveryCode: code, active: true,
            $and: [
                { $or: [{ expiresAt: null }, { expiresAt: { $gt: now() } }] },
                { $or: [{ platforms: { $exists: false } }, { platforms: { $size: 0 } }, ...(platform ? [{ platforms: platform }] : [])] },
            ],
        }).lean();
        return {
            accountScope: createHash('sha256').update(code).digest('hex'),
            announcement: record && typeof record.message === 'string' && record.message.trim() ? {
                active: true, id: record.id || String(record._id), title: record.title,
                message: record.message, displayMode: record.displayMode === 'popup' ? 'popup' : 'banner',
                expiresAt: record.expiresAt || null,
            } : null,
        };
    };
}
module.exports = { createUserAnnouncements };
