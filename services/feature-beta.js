const FEATURE_KEYS = ['smartNotes', 'smartReply', 'bookStudio'];

const DEFAULT_FEEDBACK_MESSAGE =
  'We are actively improving this feature. If you encounter any issue or have feedback, email us at taptapcreate43@gmail.com and we will help you.';

const DEFAULT_GLOBAL_FEEDBACK_MESSAGE =
  'You can send any feedback or query to TapTap Create at taptapcreate43@gmail.com if you encounter any problem.';

const DEFAULT_CROSS_DEVICE_COPY = Object.freeze({
  enabled: false,
  plansMessage:
    'Use your AI Notes recovery code to bring your purchased credits to another device. It works across Android, iPhone, iPad, and the macOS desktop app.',
  onboardingDescription:
    'If you use AI Notes on another device, connect your recovery code to use the same purchased credit balance. Use Restore Purchases with the Apple Account that subscribed to Pro.',
  settingsMessage:
    'Enter the recovery code from your other device. Each code keeps its own balance, and your notes stay on this Mac.',
});

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

function globalFeedbackState(config) {
  const entry = config?.globalFeedback || {};
  const enabled = entry.enabled === true;
  const rawMessage = typeof entry.message === 'string' ? entry.message.trim() : '';
  return {
    enabled,
    message: rawMessage.slice(0, MAX_FEEDBACK_LENGTH),
  };
}

function crossDeviceCreditCopyState(config) {
  const entry = config?.crossDeviceCreditCopy || {};
  const enabled = entry.enabled === true;
  const pick = (field) => {
    const raw = typeof entry[field] === 'string' ? entry[field].trim() : '';
    return (raw || DEFAULT_CROSS_DEVICE_COPY[field]).slice(0, MAX_FEEDBACK_LENGTH);
  };
  return {
    enabled,
    plansMessage: pick('plansMessage'),
    onboardingDescription: pick('onboardingDescription'),
    settingsMessage: pick('settingsMessage'),
  };
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
  for (const [field, value] of [
    ['enabled', true],
    ['message', DEFAULT_GLOBAL_FEEDBACK_MESSAGE],
  ]) {
    const path = `globalFeedback.${field}`;
    ops.push({
      updateOne: {
        filter: { key: 'master_config', [path]: { $exists: false } },
        update: { $set: { [path]: value } },
      },
    });
  }
  ops.push({
    updateOne: {
      filter: { key: 'master_config', 'billingControls.showLifetimeFreeCredits': { $exists: false } },
      update: { $set: { 'billingControls.showLifetimeFreeCredits': true } },
    },
  });
  for (const [field, value] of Object.entries(DEFAULT_CROSS_DEVICE_COPY)) {
    const path = `crossDeviceCreditCopy.${field}`;
    ops.push({
      updateOne: {
        filter: { key: 'master_config', [path]: { $exists: false } },
        update: { $set: { [path]: value } },
      },
    });
  }
  await Config.collection.bulkWrite(ops);
}

module.exports = {
  FEATURE_KEYS,
  DEFAULT_FEEDBACK_MESSAGE,
  DEFAULT_GLOBAL_FEEDBACK_MESSAGE,
  DEFAULT_CROSS_DEVICE_COPY,
  MAX_FEEDBACK_LENGTH,
  featureBetaState,
  globalFeedbackState,
  crossDeviceCreditCopyState,
  initializeFeatureBeta,
};
