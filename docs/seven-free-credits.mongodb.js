// Run in MongoDB shell against ai_notes_app. This is a one-time policy change,
// not a reset of existing claimed/spent balances. It affects all platforms.
const notesDB = db.getSiblingDB('ai_notes_app');
notesDB.appconfigs.updateOne(
  { key: 'master_config' },
  { $set: { dailyFreeCreditsEnabled: false, welcomePackCredits: 7, updatedAt: new Date() } }
);
notesDB.appconfigs.findOne(
  { key: 'master_config' },
  { _id: 0, dailyFreeCreditsEnabled: 1, welcomePackCredits: 1, generationBillingRequired: 1, subscriberDailyLimit: 1 }
);
// Leave generationBillingRequired unchanged until updated mobile clients are public.
