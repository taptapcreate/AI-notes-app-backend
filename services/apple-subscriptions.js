const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const {
    SignedDataVerifier,
    Environment,
} = require('@apple/app-store-server-library');
const { CreditError } = require('./credit-policy');
const { dailySubscriptionUsage, requestHistoryUsage, monthlyAllowances, MONTHLY_PRODUCT } = require('./subscription-usage');
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
function storeKitAllowancePeriod(payload) {
    if (payload.productId !== MONTHLY_PRODUCT) return null;
    if (payload.offerDiscountType === 'FREE_TRIAL' || (payload.offerType === 1 && payload.price === 0))
        return 'trial';
    if (payload.price > 0 || ['PAY_AS_YOU_GO', 'PAY_UP_FRONT'].includes(payload.offerDiscountType) ||
        (payload.offerType == null && payload.price == null)) return 'monthly';
    return null;
}

// A trial spans one Apple transaction. Only a new transaction can start a paid period.
function allowancePeriodFor(current, transactionId, period) {
    if (current.transactionId !== transactionId) return period;
    if (current.allowancePeriod === 'trial') return 'trial';
    return period ?? current.allowancePeriod ?? null;
}

// An omitted scope preserves compatibility with existing clients. An empty
// scope is an explicit StoreKit check that found no current sandbox entitlement.
function canUseAppleRecord(record, sandboxIds) {
    return record.environment !== 'Sandbox' || sandboxIds === undefined || sandboxIds.includes(record._id);
}

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
    const Backup = require('../models/AccountRecovery');
    const subscriptionRecovery = require('./account-recovery').createAccountRecovery({ Account: Subscription, Backup, kind: 'subscription', now });
    const walletRecovery = require('./account-recovery').createAccountRecovery({ Account: User, Backup, kind: 'wallet', now });
    const transaction = async (work) => {
        await Backup.init();
        for (let attempt = 0; ; attempt++) {
            const session = await User.db.startSession();
            try { return await session.withTransaction(() => work(session)); }
            catch (error) { if (error.code !== 11000 || attempt >= 9) throw error; }
            finally { await session.endSession(); }
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
    async function recordFor(user, session, sandboxIds) {
        const ids = user.appleSubscriptionIds || [];
        if (!ids.length) return null;
        if (!session) return transaction(inner => recordFor(user, inner, sandboxIds));
        for (const id of ids) {
            try {
                await subscriptionRecovery.ensure(id, session);
                await subscriptionRecovery.checkpoint(id, session);
            } catch (error) { if (error.status !== 404) throw error; }
        }
        const query = Subscription.find({ _id: { $in: ids } }).sort({
            expiresAt: -1,
        });
        if (session) query.session(session);
        const records = (await query.lean()).filter(record => canUseAppleRecord(record, sandboxIds));
        return records.find((record) => active(record)) || records[0] || null;
    }
    async function status(user, sandboxIds) {
        if (!user.appleSubscriptionIds?.length) return null;
        const record = await recordFor(user, undefined, sandboxIds);
        return {
            isPro: !!active(record),
            appleSubscriptionBound: true,
            sandboxExcluded: !record && sandboxIds !== undefined,
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
    async function usage(user, config, timestamp = now(), sandboxIds) {
        const record = await recordFor(user, undefined, sandboxIds);
        return {
            ...await requestHistoryUsage(
                record || (user.appleSubscriptionIds?.length ? { recoveryCode: user.recoveryCode } : user),
                config ?? await getAppConfig(),
                timestamp,
                undefined,
                GenerationRequest,
            ),
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
        await transaction(async (session) => {
            const user = code ? await walletRecovery.ensure(code, session) : null;
            let current;
            try { current = await subscriptionRecovery.ensure(id, session); }
            catch (error) {
                if (error.status !== 404) throw error;
                if (user?.appleSubscriptionIds?.includes(id))
                    throw new CreditError(503, 'Subscription recovery needs support. No confirmed usage backup is available.');
                const [created] = await Subscription.create([{
                    _id: id, environment: payload.environment,
                    originalTransactionId: payload.originalTransactionId,
                }], { session });
                current = created.toObject();
            }
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
            if (newer) {
                Object.assign(set, {
                    transactionId: payload.transactionId,
                    productId: payload.productId,
                    purchaseDate: current.transactionId === payload.transactionId && current.purchaseDate
                        ? current.purchaseDate : date(payload.purchaseDate),
                    allowancePeriod: allowancePeriodFor(current, payload.transactionId, storeKitAllowancePeriod(payload)),
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
            }
            if (
                payload.revocationDate &&
                current.transactionId === payload.transactionId
            )
                set.revokedAt = date(payload.revocationDate);
            const walletHash = code && hash(code);
            const alreadyLinked = user?.appleSubscriptionIds?.includes(id);
            const link = user && (alreadyLinked || active({ ...current, ...set }, timestamp));
            const markWallet = link && !(current.migratedWallets || []).includes(walletHash);
            if (markWallet && !alreadyLinked) {
                const config = await getAppConfig();
                let used = dailySubscriptionUsage(
                    current,
                    config,
                    timestamp,
                ).subscriberDailyUsage;
                const legacyUsage = !user.appleSubscriptionIds?.length
                    ? dailySubscriptionUsage(user, config, timestamp).subscriberDailyUsage
                    : 0;
                used += legacyUsage;
                // Preserve same-day usage when a production subscription changes.
                // Different sandbox testers each have their own allowance.
                if (
                    payload.environment === 'Production' &&
                    !current.migratedWallets?.length &&
                    user.appleSubscriptionIds?.length
                ) {
                    const older = await Subscription.find({
                        environment: 'Production',
                        _id: {
                            $in: user.appleSubscriptionIds.filter(
                                (value) => value !== id,
                            ),
                        },
                    })
                        .session(session)
                        .lean();
                    for (const previous of older)
                        used += dailySubscriptionUsage(
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
                if (GenerationRequest && legacyUsage > 0) {
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
                                ...(current.quotaEpoch ? { 'reservation.quotaEpoch': current.quotaEpoch } : {}),
                                'reservation.day':
                                    set.lastRequestReset.toISOString(),
                            },
                        },
                        { session },
                    );
                }
                if (
                    !current.migratedWallets?.length &&
                    !user.appleSubscriptionIds?.length &&
                    user.subscriberDailyLimitOverride != null
                )
                    set.subscriberDailyLimitOverride =
                        user.subscriberDailyLimitOverride;
            }
            const update = {
                $set: set,
                $addToSet: { revokedTransactions: { $each: [...revoked] } },
            };
            if (markWallet) update.$addToSet.migratedWallets = walletHash;
            await Subscription.updateOne({ _id: id }, update, { session });
            if (link)
                await User.updateOne(
                    { _id: user._id },
                    { $addToSet: { appleSubscriptionIds: id } },
                    { session },
                );
            await subscriptionRecovery.checkpoint(id, session);
            if (user) await walletRecovery.checkpoint(code, session);
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
            let record;
            try { record = await subscriptionRecovery.ensure(id, session); }
            catch (error) { if (error.status === 404) return false; throw error; }
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
                date(event.purchased_at_ms) &&
                (event.purchased_at_ms > new Date(record.purchaseDate || 0).getTime() ||
                    event.transaction_id === record.transactionId) &&
                record.expiredTransactionId !== event.transaction_id &&
                !(record.revokedTransactions || []).includes(
                    event.transaction_id,
                )
            ) {
                Object.assign(set, {
                    transactionId: event.transaction_id,
                    productId: event.product_id,
                    purchaseDate: event.transaction_id === record.transactionId && record.purchaseDate
                        ? record.purchaseDate : date(event.purchased_at_ms),
                    allowancePeriod: allowancePeriodFor(record, event.transaction_id,
                        event.product_id !== MONTHLY_PRODUCT ? null
                            : event.period_type === 'TRIAL' ? 'trial'
                              : ['NORMAL', 'INTRO', 'PREPAID'].includes(event.period_type) ? 'monthly' : null),
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
            await subscriptionRecovery.checkpoint(id, session);
            return true;
        });
    }
    async function resolveStoreKitScope(proofs, user) {
        if (proofs === undefined) return undefined;
        if (!Array.isArray(proofs) || proofs.length > 4)
            throw new CreditError(400, 'Provide up to four StoreKit subscription proofs');
        const decoded = await Promise.all(proofs.map(proof => verify(proof)));
        const linked = new Set(user?.appleSubscriptionIds || []);
        if (linked.size) {
            const recoverable = decoded.filter(payload =>
                validID(payload.originalTransactionId) &&
                linked.has(identity(payload.environment, payload.originalTransactionId)) &&
                active({
                    expiresAt: date(payload.expiresDate),
                    revokedAt: payload.revocationDate,
                    isUpgraded: payload.isUpgraded,
                }),
            );
            const ids = recoverable.map(payload => identity(payload.environment, payload.originalTransactionId));
            if (ids.length) {
                const existing = await Subscription.find({ _id: { $in: ids } }).lean();
                const byID = new Map(existing.map(record => [record._id, record]));
                const useMonthly = monthlyAllowances(await getAppConfig());
                for (const payload of recoverable) {
                    const record = byID.get(identity(payload.environment, payload.originalTransactionId));
                    const period = useMonthly && storeKitAllowancePeriod(payload);
                    const refreshPeriod = useMonthly && record && payload.productId === MONTHLY_PRODUCT &&
                        (payload.purchaseDate > new Date(record.purchaseDate || 0).getTime() ||
                            (record.transactionId === payload.transactionId && period &&
                                allowancePeriodFor(record, payload.transactionId, period) !== record.allowancePeriod));
                    if (!record?.transactionId || refreshPeriod)
                        await savePayload(payload, user.recoveryCode);
                }
            }
        }
        return [...new Set(decoded.filter(payload =>
            payload.environment === 'Sandbox' &&
            payload.bundleId === BUNDLE_ID &&
            PRODUCTS.has(payload.productId) &&
            validID(payload.originalTransactionId) &&
            !payload.revocationDate &&
            payload.isUpgraded !== true
        ).map(payload => identity(payload.environment, payload.originalTransactionId)))];
    }
    return { attach, status, usage, webhook, active, recordFor, resolveStoreKitScope };
}
module.exports = {
    canUseAppleRecord,
    createAppleSubscriptions,
    appleVerifier,
    identity,
    BUNDLE_ID,
};
