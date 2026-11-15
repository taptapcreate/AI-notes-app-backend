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


test('platform visibility fields persist and serialize independently with backward-compatible defaults', () => {
    const { platformBillingControls } = require('../services/billing-controls');
    const document = new AppConfig({ billingControls: { showSubscriptions: false },
        platformBillingControls: { windows: { showSubscriptions: false }, ios: { showTopUpPacks: false } } });
    assert.equal(document.validateSync(), undefined);
    const reloaded = new AppConfig(JSON.parse(JSON.stringify(document)));
    const controls = platformBillingControls(reloaded);
    assert.deepEqual(controls.windows, { showSubscriptions: false, showTopUpPacks: true });
    assert.deepEqual(controls.ios, { showSubscriptions: true, showTopUpPacks: false });
    assert.deepEqual(controls.macos, { showSubscriptions: true, showTopUpPacks: true });
    assert.deepEqual(controls.android, controls.macos);
    assert.equal(billingControls(reloaded).showSubscriptions, false);
    assert.equal(platformBillingControls({}).windows.showSubscriptions, true);
    assert.equal(reloaded.platformBillingControls.windows.usePrimarySubscriptionTracking, undefined);
});
