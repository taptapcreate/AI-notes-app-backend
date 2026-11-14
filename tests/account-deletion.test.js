const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createDeletedAccountLookup } = require('../services/account-deletion');

test('existing deleted accounts can still be identified after deletion is disabled', async () => {
    const hash = createHash('sha256').update('REMOVED-CODE').digest('hex');
    const accountWasDeleted = createDeletedAccountLookup({
        exists: async ({ _id }) => _id === hash ? { _id } : null,
    });
    assert.equal(await accountWasDeleted('removed-code'), true);
    assert.equal(await accountWasDeleted('active-code'), false);
    assert.equal(await accountWasDeleted(null), false);
});
