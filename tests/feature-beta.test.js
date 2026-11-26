const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const AppConfig = require('../models/AppConfig');
const {
  DEFAULT_FEEDBACK_MESSAGE,
  DEFAULT_GLOBAL_FEEDBACK_MESSAGE,
  DEFAULT_CROSS_DEVICE_COPY,
  featureBetaState,
  globalFeedbackState,
  crossDeviceCreditCopyState,
  initializeFeatureBeta,
} = require('../services/feature-beta');

test('featureBeta and globalFeedback initialize missing fields without overwriting operator edits', async () => {
  assert.deepEqual(featureBetaState(null), {
    smartNotes: { beta: false, showFeedbackMessage: false, feedbackMessage: '' },
    smartReply: { beta: false, showFeedbackMessage: false, feedbackMessage: '' },
    bookStudio: { beta: false, showFeedbackMessage: false, feedbackMessage: '' },
  });
  assert.deepEqual(globalFeedbackState(null), { enabled: false, message: '' });

  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  try {
    await AppConfig.collection.insertOne({ key: 'master_config' });
    await initializeFeatureBeta(AppConfig);
    const created = await AppConfig.findOne({ key: 'master_config' }).lean();
    const first = featureBetaState(created);
    assert.equal(first.smartNotes.beta, false);
    assert.equal(first.smartReply.beta, false);
    assert.equal(first.bookStudio.beta, false);
    assert.equal(first.bookStudio.showFeedbackMessage, false);
    assert.equal(first.bookStudio.feedbackMessage, DEFAULT_FEEDBACK_MESSAGE);
    assert.deepEqual(globalFeedbackState(created), {
      enabled: true,
      message: DEFAULT_GLOBAL_FEEDBACK_MESSAGE,
    });
    assert.deepEqual(crossDeviceCreditCopyState(created), { ...DEFAULT_CROSS_DEVICE_COPY });

    // Simulate operator toggling flags and editing messages in DB.
    await AppConfig.updateOne(
      { key: 'master_config' },
      {
        $set: {
          'featureBeta.bookStudio.beta': true,
          'featureBeta.bookStudio.showFeedbackMessage': true,
          'featureBeta.bookStudio.feedbackMessage': 'Custom beta note for taptapcreate43@gmail.com',
          'globalFeedback.enabled': false,
          'globalFeedback.message': 'Paused temporarily',
          'crossDeviceCreditCopy.enabled': true,
          'crossDeviceCreditCopy.plansMessage': 'Updated cross-device transfer message.',
        },
      },
    );
    await initializeFeatureBeta(AppConfig);
    const updated = await AppConfig.findOne({ key: 'master_config' }).lean();
    const state = featureBetaState(updated);
    assert.equal(state.bookStudio.beta, true);
    assert.equal(state.bookStudio.showFeedbackMessage, true);
    assert.equal(state.bookStudio.feedbackMessage, 'Custom beta note for taptapcreate43@gmail.com');
    assert.equal(state.smartNotes.beta, false);
    assert.deepEqual(globalFeedbackState(updated), {
      enabled: false,
      message: 'Paused temporarily',
    });
    assert.equal(crossDeviceCreditCopyState(updated).enabled, true);
    assert.equal(crossDeviceCreditCopyState(updated).plansMessage, 'Updated cross-device transfer message.');
  } finally {
    await mongoose.disconnect();
    await mongod.stop();
  }
});
