const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const {
    SignedDataVerifier,
    Environment,
} = require('@apple/app-store-server-library');
const { CreditError } = require('./credit-policy');
const { subscriptionUsage } = require('./subscription-usage');
const BUNDLE_ID = 'com.taptapcreate.ainotes';
const PRODUCTS = new Set([
    'ai_notes_pro_weekly_subscription',
    'ai_notes_pro_monthly_subscription',
]);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const identity = (environment, original) =>
    hash(`apple:${BUNDLE_ID}:${environment}:${original}`);
const validID = (value) =>
    typeof value === 'string' && /^[0-9]{1,40}$/.test(value);
const date = (value) =>
    Number.isSafeInteger(value) && value > 0 && value <= 8640000000000000
        ? new Date(value)
        : null;
function appleVerifier() {
    const roots = ['AppleRootCA-G2.cer', 'AppleRootCA-G3.cer'].map((name) =>
        readFileSync(path.join(__dirname, '../certificates', name)),
    );
    const verifiers = [Environment.PRODUCTION, Environment.SANDBOX].map(
        (environment) =>
            new SignedDataVerifier(
                roots,
                false,
                environment,
                BUNDLE_ID,
                6757496314,
            ),
    );
    const cache = new Map();
    return async (signed) => {
        if (
            typeof signed !== 'string' ||
            signed.length > 30000 ||
            signed.split('.').length !== 3
        )
            throw new CreditError(400, 'Invalid Apple subscription proof');
        const key = hash(signed);
        const cached = cache.get(key);
        if (cached && cached.until > Date.now()) return cached.payload;
        for (const verifier of verifiers) {
            try {
                const payload =
                    await verifier.verifyAndDecodeTransaction(signed);
                if (cache.size >= 200) cache.delete(cache.keys().next().value);
                cache.set(key, { until: Date.now() + 300000, payload });
                return payload;
            } catch {
                /* Try the other Apple environment. Unverified data is never used. */
            }
        }
        throw new CreditError(
            400,
            'Apple could not verify this subscription proof',
        );
    };
}
function createAppleSubscriptions({
    User,
    Subscription,
    GenerationRequest,
    getAppConfig,
    verify = appleVerifier(),
    now = () => new Date(),
}) {
    const transaction = async (work) => {
        const session = await User.db.startSession();
        try {
            return await session.withTransaction(() => work(session));
        } finally {
            await session.endSession();
        }
    };
    const active = (record, timestamp = now()) =>
        record &&
        !record.revokedAt &&
        !record.isUpgraded &&
        Math.max(
            new Date(record.expiresAt || 0).getTime(),
            new Date(record.graceExpiresAt || 0).getTime(),
        ) > timestamp.getTime();
    async function recordFor(user, session) {
        const ids = user.appleSubscriptionIds || [];
        if (!ids.length) return null;
        const query = Subscription.find({ _id: { $in: ids } }).sort({
            expiresAt: -1,
        });
        if (session) query.session(session);
        const records = await query.lean();
        return records.find((record) => active(record)) || records[0] || null;
    }
    async function status(user) {
        if (!user.appleSubscriptionIds?.length) return null;
        const record = await recordFor(user);
        return {
            isPro: !!active(record),
            appleSubscriptionBound: true,
            subscriptionIdentityVersion: 1,
            quotaId: record?._id,
            plan: record?.productId
                ? record.productId.includes('monthly')
                    ? 'monthly'
                    : 'weekly'
                : null,
            expiresAt: record?.expiresAt?.toISOString() || null,
            ...(record?.environment === 'Sandbox' ? { sandbox: true } : {}),
        };
    }
    async function usage(user, config, timestamp = now()) {
        const record = await recordFor(user);
        return {
            ...subscriptionUsage(record || user, config, timestamp),
            subscriptionIdentityVersion: 1,
            appleSubscriptionBound: !!record,
        };
    }
    async function savePayload(payload, code) {
        const timestamp = now();
        if (
            !PRODUCTS.has(payload.productId) ||
            payload.bundleId !== BUNDLE_ID ||
            !['Production', 'Sandbox'].includes(payload.environment) ||
            !validID(payload.originalTransactionId) ||
            !validID(payload.transactionId) ||
            !date(payload.expiresDate) ||
            !date(payload.purchaseDate) ||
            !date(payload.signedDate) ||
            payload.signedDate > timestamp.getTime() + 300000
        )
            throw new CreditError(
                400,
                'This is not a valid AI Notes subscription',
            );
        const id = identity(payload.environment, payload.originalTransactionId);
        // Create outside the transaction so a simultaneous first restore can safely retry.
        try {
            await Subscription.updateOne(
                { _id: id },
                {
                    $setOnInsert: {
                        environment: payload.environment,
                        originalTransactionId: payload.originalTransactionId,
                    },
                },
                { upsert: true },
            );
        } catch (error) {
            if (error.code !== 11000) throw error;
        }
        await transaction(async (session) => {
            const user = code
                ? await User.findOne({ recoveryCode: code })
                      .session(session)
                      .lean()
                : null;
            if (code && !user)
                throw new CreditError(404, 'Recovery code not found');
            const current = await Subscription.findById(id)
                .session(session)
                .lean();
            const set = {};
            const revoked = new Set(current.revokedTransactions || []);
            if (payload.revocationDate) revoked.add(payload.transactionId);
            const newer =
                !current.transactionId ||
                payload.purchaseDate >
                    new Date(current.purchaseDate || 0).getTime() ||
                (payload.transactionId === current.transactionId &&
                    payload.signedDate >=
                        new Date(current.signedAt || 0).getTime());
            if (newer)
                Object.assign(set, {
                    transactionId: payload.transactionId,
                    productId: payload.productId,
                    purchaseDate: date(payload.purchaseDate),
                    expiresAt:
                        current.expiredTransactionId === payload.transactionId
                            ? current.expiresAt
                            : date(payload.expiresDate),
                    ...(current.transactionId !== payload.transactionId
                        ? { graceExpiresAt: null }
                        : {}),
                    signedAt: date(payload.signedDate),
                    isUpgraded: payload.isUpgraded === true,
                    revokedAt: revoked.has(payload.transactionId)
                        ? date(payload.revocationDate) ||
                          current.revokedAt ||
                          timestamp
                        : null,
                });
            if (
                payload.revocationDate &&
                current.transactionId === payload.transactionId
            )
                set.revokedAt = date(payload.revocationDate);
            const walletHash = code && hash(code);
            const link =
                user &&
                (user.appleSubscriptionIds?.includes(id) ||
                    active({ ...current, ...set }, timestamp));
            const migrate =
                link && !(current.migratedWallets || []).includes(walletHash);
            if (migrate) {
                const config = await getAppConfig();
                let used = subscriptionUsage(
                    current,
                    config,
                    timestamp,
                ).subscriberDailyUsage;
                used += subscriptionUsage(
                    user,
                    config,
                    timestamp,
                ).subscriberDailyUsage;
                // A genuinely new subscription family must not replenish an existing same-day allowance.
                if (
                    !current.migratedWallets?.length &&
                    user.appleSubscriptionIds?.length
                ) {
                    const older = await Subscription.find({
                        _id: {
                            $in: user.appleSubscriptionIds.filter(
                                (value) => value !== id,
                            ),
                        },
                    })
                        .session(session)
                        .lean();
                    for (const previous of older)
                        used += subscriptionUsage(
                            previous,
                            config,
                            timestamp,
                        ).subscriberDailyUsage;
                }
                set.dailyRequestCount = used;
                const midnight = new Date(timestamp);
                midnight.setUTCHours(0, 0, 0, 0);
                const previousReset = new Date(current.lastRequestReset || 0);
                set.lastRequestReset =
                    previousReset >= midnight &&
                    previousReset < new Date(midnight.getTime() + 86400000)
                        ? previousReset
                        : midnight;
                if (
                    GenerationRequest &&
                    subscriptionUsage(user, config, timestamp)
                        .subscriberDailyUsage > 0
                ) {
                    // Pending legacy requests must refund the counter that inherited their reservation.
                    await GenerationRequest.updateMany(
                        {
                            recoveryCode: code,
                            state: 'pending',
                            'reservation.pro': true,
                            'reservation.subscriptionId': { $exists: false },
                            'reservation.day': new Date(
                                user.lastRequestReset,
                            ).toISOString(),
                        },
                        {
                            $set: {
                                'reservation.subscriptionId': id,
                                'reservation.day':
                                    set.lastRequestReset.toISOString(),
                            },
                        },
                        { session },
                    );
                }
                if (
                    !current.migratedWallets?.length &&
                    user.subscriberDailyLimitOverride != null
                )
                    set.subscriberDailyLimitOverride =
                        user.subscriberDailyLimitOverride;
            }
            const update = {
                $set: set,
                $addToSet: { revokedTransactions: { $each: [...revoked] } },
            };
            if (migrate) update.$addToSet.migratedWallets = walletHash;
            await Subscription.updateOne({ _id: id }, update, { session });
            if (link)
                await User.updateOne(
                    { _id: user._id },
                    { $addToSet: { appleSubscriptionIds: id } },
                    { session },
                );
        });
        return id;
    }
    async function attach(code, proofs) {
        if (!Array.isArray(proofs) || proofs.length < 1 || proofs.length > 4)
            throw new CreditError(
                400,
                'Provide up to four Apple subscription proofs',
            );
        // Verify the whole batch before changing any account association.
        const decoded = await Promise.all(proofs.map((proof) => verify(proof)));
        for (const payload of decoded) await savePayload(payload, code);
        const user = await User.findOne({ recoveryCode: code }).lean();
        return {
            success: true,
            ...(await status(user)),
            ...(await usage(user, await getAppConfig())),
        };
    }
    async function webhook(event) {
        if (
            !PRODUCTS.has(event.product_id) ||
            !['APP_STORE', 'MAC_APP_STORE'].includes(event.store) ||
            !['PRODUCTION', 'SANDBOX'].includes(event.environment) ||
            !validID(event.original_transaction_id) ||
            !validID(event.transaction_id)
        )
            return false;
        const environment =
            event.environment === 'SANDBOX' ? 'Sandbox' : 'Production';
        const id = identity(environment, event.original_transaction_id);
        const stamp = date(event.event_timestamp_ms);
        if (
            !stamp ||
            ![
                'INITIAL_PURCHASE',
                'RENEWAL',
                'UNCANCELLATION',
                'PRODUCT_CHANGE',
                'CANCELLATION',
                'EXPIRATION',
                'BILLING_ISSUE',
            ].includes(event.type)
        )
            return false;
        // The webhook updates only subscriptions already verified through StoreKit.
        return transaction(async (session) => {
            const record = await Subscription.findById(id)
                .session(session)
                .lean();
            if (!record) return false;
            const refunded =
                event.type === 'CANCELLATION' &&
                event.cancel_reason === 'CUSTOMER_SUPPORT' &&
                event.expiration_at_ms <= now().getTime();
            if (!refunded && record.lastEventAt && record.lastEventAt >= stamp)
                return true;
            const expiry = date(event.expiration_at_ms);
            const set = {
                lastEventAt:
                    record.lastEventAt > stamp ? record.lastEventAt : stamp,
            };
            if (
                [
                    'INITIAL_PURCHASE',
                    'RENEWAL',
                    'UNCANCELLATION',
                    'PRODUCT_CHANGE',
                ].includes(event.type) &&
                expiry &&
                event.purchased_at_ms >=
                    new Date(record.purchaseDate || 0).getTime() &&
                record.expiredTransactionId !== event.transaction_id &&
                !(record.revokedTransactions || []).includes(
                    event.transaction_id,
                )
            ) {
                Object.assign(set, {
                    transactionId: event.transaction_id,
                    productId: event.product_id,
                    purchaseDate: date(event.purchased_at_ms),
                    expiresAt: expiry,
                    revokedAt: null,
                    isUpgraded: false,
                    ...(event.transaction_id !== record.transactionId
                        ? { graceExpiresAt: null }
                        : {}),
                });
            }
            if (event.transaction_id === record.transactionId) {
                if (refunded) set.revokedAt = stamp;
                if (event.type === 'EXPIRATION' && expiry) {
                    set.expiresAt = expiry;
                    set.expiredTransactionId = event.transaction_id;
                    set.graceExpiresAt = null;
                } else if (date(event.grace_period_expiration_at_ms)) {
                    set.graceExpiresAt = date(
                        event.grace_period_expiration_at_ms,
                    );
                }
            }
            const update = { $set: set };
            if (refunded)
                update.$addToSet = {
                    revokedTransactions: event.transaction_id,
                };
            await Subscription.updateOne({ _id: id }, update, { session });
            return true;
        });
    }
    return { attach, status, usage, webhook, active, recordFor };
}
module.exports = {
    createAppleSubscriptions,
    appleVerifier,
    identity,
    BUNDLE_ID,
};
