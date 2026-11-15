const { test } = require('node:test');
const assert = require('node:assert/strict');
const AppConfig = require('../models/AppConfig');
const { billingControls } = require('../services/billing-controls');

test('legacy app configurations expose both purchase categories by default', () => {
    assert.deepEqual(billingControls({}), { showSubscriptions: true, showTopUpPacks: true, usePrimarySubscriptionTracking: true });
    assert.deepEqual(new AppConfig({ key: 'master_config' }).billingControls.toObject(),
        { showSubscriptions: true, showTopUpPacks: true, usePrimarySubscriptionTracking: true });
});

test('purchase categories can be disabled independently and persist as schema fields', () => {
    for (const showSubscriptions of [true, false]) {
        for (const showTopUpPacks of [true, false]) {
            const values = { showSubscriptions, showTopUpPacks, usePrimarySubscriptionTracking: true };
            const document = new AppConfig({ billingControls: values });
            assert.equal(document.validateSync(), undefined);
            assert.deepEqual(billingControls(document), values);
        }
    }
});
