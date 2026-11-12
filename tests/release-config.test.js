const { test } = require('node:test');
const assert = require('node:assert/strict');
const { releaseConfig } = require('../services/release-config');
const AppConfig = require('../models/AppConfig');

test('legacy config supplies the field names understood by installed mobile clients', () => {
    const value = releaseConfig({ minAppVersion: '1.0.4', latestAppVersion: '1.0.4', updateUrl: 'https://apps.apple.com/app/id...' });
    assert.equal(value.ios.latestVersion, '1.0.4');
    assert.equal(value.ios.forceUpdate, true);
    assert.equal(value.ios.storeUrl, 'https://apps.apple.com/app/id6757496314');
    assert.equal(new URL(value.android.storeUrl).hostname, 'play.google.com');
});
test('iOS mandatory update can be staged independently from Android', () => {
    const config = { ios: { minVersion: '1.0.4', latestVersion: '1.0.5' }, android: { minVersion: '1.0.0', latestVersion: '1.0.0' } };
    const value = releaseConfig(config);
    assert.equal(value.ios.forceUpdate, true);
    assert.equal(value.ios.forceLatest, false);
    assert.equal(value.android.forceUpdate, false);
    assert.equal(value.android.latestVersion, '1.0.0');
    assert.equal(config.ios.minVersion, '1.0.4');
});
test('invalid metadata cannot expose an unsafe store URL or latest below minimum', () => {
    const value = releaseConfig({ ios: { minVersion: '1.0.10', latestVersion: '1.0.2', storeUrl: 'https://example.com', releaseNotes: [null, '', 'New credit system'] } });
    assert.equal(value.ios.latestVersion, '1.0.10');
    assert.equal(new URL(value.ios.storeUrl).hostname, 'apps.apple.com');
    assert.deepEqual(value.ios.releaseNotes, ['New credit system']);
});
test('schema persists platform settings without activating a forced update by default', () => {
    const config = new AppConfig({ ios: { minVersion: '1.0.4', latestVersion: '1.0.4', releaseNotes: ['Credits update'] } });
    assert.equal(config.validateSync(), undefined);
    assert.equal(config.android, undefined);
    assert.equal(releaseConfig(new AppConfig({})).ios.forceUpdate, false);
    assert.ok(new AppConfig({ android: { minVersion: 'invalid' } }).validateSync());
});
