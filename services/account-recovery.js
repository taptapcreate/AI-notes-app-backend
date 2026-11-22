const { createHash } = require('node:crypto');
const { CreditError } = require('./credit-policy');
const { timeSubscriptionOperation: timeSubscription } = require('./subscription-timing');

// All account mutations and checkpoints share one MongoDB transaction.
// Every balance mutation and its checkpoint MUST share the supplied transaction.
function createAccountRecovery({ Account, Backup, kind, now = () => new Date() }) {
    if (!['wallet', 'subscription'].includes(kind)) throw new Error('Invalid recovery kind');
    const field = kind === 'wallet' ? 'recoveryCode' : '_id';
    const key = identity => {
        if (typeof identity !== 'string' || !identity || identity.length > 512)
            throw new CreditError(400, 'Invalid recovery identity');
        return createHash('sha256').update(kind + ':' + identity).digest('hex');
    };
    function validate(snapshot, identity) {
        if (!snapshot || snapshot._id == null || snapshot[field] !== identity)
            throw new CreditError(503, 'Account backup needs support review');
        const counters = kind === 'wallet'
            ? ['credits', 'adCredits', 'totalFreeCredits', 'freeCreditsRemaining', 'dailyRequestCount']
            : ['dailyRequestCount', 'periodRequestCount'];
        if (counters.some(name => snapshot[name] != null &&
            (!Number.isSafeInteger(snapshot[name]) || snapshot[name] < 0)))
            throw new CreditError(503, 'Account backup needs support review');
    }
    function requireTransaction(session) {
        if (!session?.inTransaction()) throw new Error('Account recovery requires an active transaction');
    }
    async function assertRecoverable(identity, session) {
        if (kind === 'wallet') {
            const hash = createHash('sha256').update(identity.toUpperCase()).digest('hex');
            if (await timeSubscription('db.deleted_account.findOne', () => Account.db.collection('deletedaccounts').findOne({ _id: hash }, { session })))
                throw new CreditError(410, 'This account was deleted and cannot be restored');
        }
    }
    async function ensure(identity, session) {
        requireTransaction(session);
        const id = key(identity);
        await assertRecoverable(identity, session);
        const existing = await timeSubscription(kind === 'wallet' ? 'db.wallet.findOne' : 'db.subscription.findOne', () => Account.findOne({ [field]: identity }).session(session).lean());
        if (existing) return existing;
        const backup = await timeSubscription('db.recovery.findById', () => Backup.findById(id).session(session).lean());
        if (!backup) throw new CreditError(404, 'No confirmed backup is available for this account');
        if (backup.identity !== identity || backup.kind !== kind)
            throw new CreditError(503, 'Account backup identity needs support review');
        validate(backup.snapshot, identity);
        await timeSubscription('db.recovery.insertOne', () => Account.collection.insertOne(backup.snapshot, { session }));
        return timeSubscription(kind === 'wallet' ? 'db.wallet.findOne' : 'db.subscription.findOne', () => Account.findOne({ [field]: identity }).session(session).lean());
    }
    async function checkpoint(identity, session) {
        requireTransaction(session);
        const id = key(identity);
        const snapshot = await timeSubscription(kind === 'wallet' ? 'db.wallet.findOne' : 'db.subscription.findOne', () => Account.findOne({ [field]: identity }).session(session).lean());
        validate(snapshot, identity);
        await timeSubscription('db.recovery.replaceOne', () => Backup.replaceOne({ _id: id }, {
            _id: id, kind, identity, snapshot, updatedAt: now(),
        }, { session, upsert: true }));
        return snapshot;
    }
    async function run(identity, operation = async () => undefined) {
        key(identity);
        const session = await Account.db.startSession();
        try {
            return await session.withTransaction(async () => {
                const account = await ensure(identity, session);
                const result = await operation({ account, session });
                const snapshot = await checkpoint(identity, session);
                return { result, snapshot };
            });
        } finally { await session.endSession(); }
    }
    return { run, ensure, checkpoint, assertRecoverable };
}
module.exports = { createAccountRecovery };
