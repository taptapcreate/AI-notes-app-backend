const { createHash } = require('node:crypto');
const { CreditError, recoveryCode } = require('./credit-policy');

const accountHash = code => createHash('sha256').update(code).digest('hex');

function createAccountDeletion({ User, CreditRegistration, GenerationRequest, PurchaseClaim,
    PendingPurchase, AppleSubscription, NotificationToken, DeletedAccount, deleteCustomer }) {
    async function remove(value) {
        const code = recoveryCode(value);
        const hash = accountHash(code);
        const filter = { recoveryCode: code };
        if (await DeletedAccount.exists({ _id: hash })) return { deleted: true };
        if (!await User.exists(filter)) throw new CreditError(404, 'AI Notes account not found');
        if (await GenerationRequest.exists({ ...filter, state: 'pending', leaseUntil: { $gt: new Date() } }))
            throw new CreditError(409, 'Wait for AI requests on your devices to finish, then try again.');

        await deleteCustomer(code);
        const session = await User.db.startSession();
        try {
            await session.withTransaction(async () => {
                if (await DeletedAccount.exists({ _id: hash }).session(session)) return;
                await User.deleteOne(filter, { session });
                await CreditRegistration.deleteMany(filter, { session });
                await GenerationRequest.deleteMany(filter, { session });
                await NotificationToken.deleteMany(filter, { session });
                await User.updateMany({ 'switchHistory.fromCode': code }, {
                    $pull: { switchHistory: { fromCode: code } },
                }, { session });
                await AppleSubscription.updateMany({ migratedWallets: hash }, {
                    $pull: { migratedWallets: hash },
                }, { session });
                await PendingPurchase.deleteMany({
                    $or: [{ rcAppUserId: code }, { linkedRecoveryCode: code },
                        { 'rawEvent.original_app_user_id': code }, { 'rawEvent.aliases': code }],
                }, { session });
                // Keep store transaction IDs reserved so previous purchases cannot grant credits again.
                await PurchaseClaim.updateMany(filter, {
                    $set: { recoveryCode: 'deleted' },
                }, { session });
                await DeletedAccount.create([{ _id: hash }], { session });
            });
        } finally {
            await session.endSession();
        }
        return { deleted: true };
    }

    return { remove, wasDeleted: async value => typeof value === 'string' &&
        !!await DeletedAccount.exists({ _id: accountHash(value.toUpperCase()) }) };
}
module.exports = { createAccountDeletion };
