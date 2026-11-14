const { createHash } = require('node:crypto');

function createDeletedAccountLookup(DeletedAccount) {
    // Existing deletion markers still prevent late events from recreating account data.
    return async value => {
        if (typeof value !== 'string') return false;
        const hash = createHash('sha256').update(value.toUpperCase()).digest('hex');
        return !!await DeletedAccount.exists({ _id: hash });
    };
}

module.exports = { createDeletedAccountLookup };
