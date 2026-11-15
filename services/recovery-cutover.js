const { createAccountRecovery } = require('./account-recovery');
async function backfillAccountRecovery({ User, Subscription, Backup, now = () => new Date() }) {
    await Backup.init();
    const metadata = User.db.collection('accountrecoverycutovers');
    const key = 'transactional-recovery-v1';
    const complete = await metadata.findOne({ _id: key, completedAt: { $exists: true } });
    if (complete) return { alreadyComplete: true, ...complete.counts };
    const counts = { wallets: 0, subscriptions: 0, deletedAccountsSkipped: 0 };
    for (const [Account, kind, field, counter] of [
        [User, 'wallet', 'recoveryCode', 'wallets'],
        [Subscription, 'subscription', '_id', 'subscriptions'],
    ]) {
        const recovery = createAccountRecovery({ Account, Backup, kind, now });
        for await (const record of Account.find().select(field).lean().cursor()) {
            try { await recovery.run(record[field]); counts[counter]++; }
            catch (error) {
                if (error.status === 410) { counts.deletedAccountsSkipped++; continue; }
                // A source removed mid-scan without any snapshot requires review;
                // never declare a complete cutover after silently missing a balance.
                throw error;
            }
        }
    }
    await metadata.updateOne({ _id: key }, { $set: { completedAt: now(), counts } }, { upsert: true });
    return { alreadyComplete: false, ...counts };
}
module.exports = { backfillAccountRecovery };
