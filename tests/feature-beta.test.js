const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const AppConfig = require('../models/AppConfig');
const {
  DEFAULT_FEEDBACK_MESSAGE,
  featureBetaState,
  initializeFeatureBeta,
} = require('../services/feature-beta');

test('featureBeta defaults to false flags and initializes missing fields without overwriting operator edits', async () => {
  assert.deepEqual(featureBetaState(null), {
    smartNotes: { beta: false, showFeedbackMessage: false, feedbackMessage: '' },
    smartReply: { beta: false, showFeedbackMessage: false, feedbackMessage: '' },
    bookStudio: { beta: false, showFeedbackMessage: false, feedbackMessage: '' },
  });

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

    // Simulate operator toggling bookStudio beta and editing message in DB.
    await AppConfig.updateOne(
      { key: 'master_config' },
      {
        $set: {
          'featureBeta.bookStudio.beta': true,
          'featureBeta.bookStudio.showFeedbackMessage': true,
          'featureBeta.bookStudio.feedbackMessage': 'Custom beta note for taptapcreate43@gmail.com',
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
  } finally {
    await mongoose.disconnect();
    await mongod.stop();
  }
});
