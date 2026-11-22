const express = require('express');
const { createHash } = require('node:crypto');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { CreditError, recoveryCode } = require('../services/credit-policy');
const { timeSubscriptionOperation: timeSubscription, subscriptionTimingActive } = require('../services/subscription-timing');

function createCreditRouter({ credits, purchases, appleSubscriptions, logger = console }) {
    const router = express.Router();
    const subscriptionAccount = code => credits.readAccount ? credits.readAccount(code) : credits.byCode(code);
    const readAnnouncement = require('../services/user-announcements').createUserAnnouncements({
        Messages: require('../models/UserAnnouncement'), credits,
    });
    const endpoint = (handler) => async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try {
            res.json(await handler(req));
        } catch (error) {
            if (!(error instanceof CreditError))
                logger.error('Credit request failed:', subscriptionTimingActive() ? 'Subscription request failed' : error.message);
            res.status(error.status || 500).json({
                error: error.status
                    ? error.message
                    : 'Unable to update credits; please try again',
                ...(error.details || {}),
            });
        }
    };
    router.get('/announcement', endpoint(req => {
        req.res.set('Cache-Control', 'no-store');
        return readAnnouncement(req.get('Authorization'), require('../services/platform').requestPlatform(req));
    }));
    router.post(
        '/register',
        rateLimit({
            windowMs: 60 * 60 * 1000,
            limit: 30,
            standardHeaders: true,
            legacyHeaders: false,
            keyGenerator: (req) =>
                typeof req.body?.deviceId === 'string' &&
                req.body.deviceId.length <= 512
                    ? `device:${createHash('sha256').update(req.body.deviceId).digest('hex')}`
                    : ipKeyGenerator(req.ip),
        }),
        endpoint((req) => credits.register(req.body || {})),
    );
    router.get(
        '/balance/:code',
        endpoint(async (req) => {
            const user = await credits.byCode(req.params.code);
            try {
                await purchases.sync(user);
            } catch (error) {
                logger.warn('Purchase sync deferred:', error.message);
            }
            return credits.balance(user.recoveryCode);
        }),
    );
    router.post('/apple-subscription', rateLimit({ windowMs: 60000, limit: 60, standardHeaders: true, legacyHeaders: false }), endpoint(async req => {
        if (!appleSubscriptions) throw new CreditError(503, 'Subscription sharing is not available on this server yet');
        const code = recoveryCode(req.body?.code);
        // attach() verifies the same account inside the proof transaction. A
        // separate lookup here repeated that recovery transaction on every sync.
        const result = await timeSubscription('attach_proofs', () => appleSubscriptions.attach(code, req.body?.transactions));
        // An explicit restore can finish with a fresh wallet snapshot, without a
        // second balance request that also synchronizes unrelated credit packs.
        if (req.body?.includeBalance === true)
            result.creditBalance = await timeSubscription('receipt_balance', () => credits.receiptBalance(code));
        return result;
    }));
    // Verify current membership and recover missing linked records from signed StoreKit proof.
    router.post(
        '/subscription',
        endpoint(async (req) => {
            const user = await timeSubscription('account_lookup', () => subscriptionAccount(req.body?.code));
            const sandboxIds = await timeSubscription('storekit_scope', () => appleSubscriptions?.resolveStoreKitScope(req.body?.storeKitProofs, user));
            const shared = appleSubscriptions?.snapshot
                ? await timeSubscription('membership', () => appleSubscriptions.snapshot(user, undefined, undefined, sandboxIds)) : null;
            const membership = shared?.membership ?? await timeSubscription('membership', () => purchases.subscriptionStatus(user, sandboxIds));
            const scopedUsage = shared?.usage ?? (appleSubscriptions
                ? await timeSubscription('allowance', () => appleSubscriptions.usage(user, undefined, undefined, sandboxIds)) : {});
            return {
                ...scopedUsage,
                ...(sandboxIds === undefined ? {} : { storeKitScopeVersion: 1 }),
                status: membership.isPro ? 'active' : 'inactive',
                ...(membership.appleSubscriptionBound ? { appleSubscriptionBound: true, subscriptionIdentityVersion: 1 } : {}),
                ...(membership.sandbox ? { sandbox: true, allowanceEnabled: membership.isPro } : {}),
                ...(membership.sandboxExcluded ? { sandboxExcluded: true } : {}),
                plan: membership.plan || null,
                expiresAt: membership.expiresAt || null,
            };
        }),
    );
    // Legacy clients may still send version/credits. Neither can authorize a grant.
    router.post(
        '/sync-welcome-pack',
        endpoint((req) => credits.syncWelcomePack(req.body?.code)),
    );
    router.post(
        '/use',
        endpoint((req) => credits.use(req.body?.code, req.body?.amount)),
    );
    router.post(
        '/recover',
        rateLimit({
            windowMs: 60 * 60 * 1000,
            limit: 5,
            standardHeaders: true,
            legacyHeaders: false,
        }),
        endpoint((req) =>
            credits.recover(req.body?.code, req.body?.currentCode),
        ),
    );
    router.post(
        '/claim-ad-reward',
        endpoint((req) => credits.claimAd(req.body?.code)),
    );
    router.post(
        '/add',
        endpoint(async (req) => {
            const code = recoveryCode(req.body?.code);
            const user = await credits.byCode(code);
            // Mobile versions send synthetic transaction IDs and arbitrary amounts.
            // Sync verified store purchases instead of trusting either client field.
            const result = req.body?.signedAppleTransaction
                ? await purchases.confirmApple(user, req.body.signedAppleTransaction, req.body.purchase)
                : await purchases.sync(user, { required: true, ...(req.body?.purchase ? { purchase: {
                productId: req.body.purchase.productId, transactionId: req.body.purchase.transactionId,
            } } : {}) });
            const current = await credits.balance(code);
            return {
                ...current,
                creditsAdded: result.credits,
                ...(result.purchase ? { purchase: result.purchase } : {}),
                newBalance: current.credits,
            };
        }),
    );
    router.get(
        '/transactions/:code',
        endpoint(async (req) => ({
            success: true,
            transactions:
                (await credits.byCode(req.params.code)).processedTransactions ||
                [],
        })),
    );
    return router;
}

module.exports = { createCreditRouter };
