const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const AppConfig = require('../models/AppConfig');
const { DEFAULT_HELP_SUPPORT, helpSupport, initializeHelpSupport } = require('../services/help-support');

test('support defaults off and normalizes only a Boolean flag and safe HTTPS links', () => {
    assert.deepEqual(helpSupport(), DEFAULT_HELP_SUPPORT);
    for (const enabled of [false, 'true', 1, null])
        assert.equal(helpSupport({ helpSupport: { enabled } }).enabled, false);
    for (const url of ['', 'http://example.com', 'javascript:alert(1)', 'file:///tmp/help', 'https://name:secret@example.com'])
        assert.equal(helpSupport({ helpSupport: { url } }).url, '');
    assert.deepEqual(helpSupport({ helpSupport: { enabled: true, title: ' Contact us ',
        message: ' Send your question. ', buttonLabel: ' Get help ', url: ' https://example.com/help ' } }),
        { enabled: true, title: 'Contact us', message: 'Send your question.', buttonLabel: 'Get help', url: 'https://example.com/help' });
    assert.equal(helpSupport({ helpSupport: { title: 'x'.repeat(81), message: 'x'.repeat(601), buttonLabel: 'x'.repeat(41) } }).title, 'More help');
});

test('support configuration persists through the model without adding defaults to older configs', () => {
    assert.equal(new AppConfig().helpSupport, undefined);
    const config = new AppConfig({ helpSupport: { enabled: false, title: 'More help', message: 'Ask us.',
        buttonLabel: 'Support', url: 'https://example.com/help' } });
    assert.equal(config.validateSync(), undefined);
    assert.equal(config.toObject().helpSupport.enabled, false);
});

test('initialization seeds only missing public support fields and preserves operator choices on restart', async () => {
    const mongo = await MongoMemoryServer.create({ binary: { version: '8.0.17' } });
    try {
        await mongoose.connect(mongo.getUri(), { dbName: 'isolated_help_support' });
        const original = { key: 'master_config', welcomePackCredits: 42, helpSupport: {
            enabled: false, title: 'Our support team', url: 'https://example.com/support' } };
        await AppConfig.collection.insertOne(original);
        await AppConfig.collection.insertOne({ key: 'other_config', label: 'leave alone' });
        await initializeHelpSupport(AppConfig);
        const seeded = await AppConfig.collection.findOne({ key: 'master_config' });
        assert.deepEqual(seeded.helpSupport, { ...DEFAULT_HELP_SUPPORT, ...original.helpSupport });
        assert.equal(seeded.welcomePackCredits, 42);
        await AppConfig.collection.updateOne({ key: 'master_config' }, { $set: { 'helpSupport.enabled': true, 'helpSupport.message': 'Custom support text.' } });
        await initializeHelpSupport(AppConfig);
        const restarted = await AppConfig.collection.findOne({ key: 'master_config' });
        assert.equal(restarted.helpSupport.enabled, true);
        assert.equal(restarted.helpSupport.message, 'Custom support text.');
        assert.equal((await AppConfig.collection.findOne({ key: 'other_config' })).helpSupport, undefined);
        assert.equal(await AppConfig.collection.countDocuments(), 2);
    } finally {
        await mongoose.disconnect();
        await mongo.stop();
    }
});
