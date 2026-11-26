const FEATURE_KEYS = ['smartNotes', 'smartReply', 'bookStudio'];

const DEFAULT_FEEDBACK_MESSAGE =
  'We are actively improving this feature. If you encounter any issue or have feedback, email us at taptapcreate43@gmail.com and we will help you.';

const MAX_FEEDBACK_LENGTH = 500;

function normalizeFeatureBetaEntry(entry) {
  const beta = entry?.beta === true;
  const showFeedbackMessage = entry?.showFeedbackMessage === true;
  const rawMessage = typeof entry?.feedbackMessage === 'string' ? entry.feedbackMessage.trim() : '';
  return {
    beta,
    showFeedbackMessage,
    feedbackMessage: rawMessage.slice(0, MAX_FEEDBACK_LENGTH),
  };
}

function featureBetaState(config) {
  const source = config?.featureBeta || {};
  return Object.fromEntries(
    FEATURE_KEYS.map((key) => [key, normalizeFeatureBetaEntry(source[key])]),
  );
}

async function initializeFeatureBeta(Config) {
  const ops = [];
  for (const key of FEATURE_KEYS) {
    for (const [field, value] of [
      ['beta', false],
      ['showFeedbackMessage', false],
      ['feedbackMessage', DEFAULT_FEEDBACK_MESSAGE],
    ]) {
      const path = `featureBeta.${key}.${field}`;
      ops.push({
        updateOne: {
          filter: { key: 'master_config', [path]: { $exists: false } },
          update: { $set: { [path]: value } },
        },
      });
    }
  }
  await Config.collection.bulkWrite(ops);
}

module.exports = {
  FEATURE_KEYS,
  DEFAULT_FEEDBACK_MESSAGE,
  MAX_FEEDBACK_LENGTH,
  featureBetaState,
  initializeFeatureBeta,
};
