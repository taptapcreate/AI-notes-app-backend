const express = require('express');
const { createHash } = require('node:crypto');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { CreditError, recoveryCode } = require('../services/credit-policy');

function createCreditRouter({ credits, purchases, appleSubscriptions, logger = console }) {
    const router = express.Router();
    const endpoint = (handler) => async (req, res) => {
        try {
            res.json(await handler(req));
        } catch (error) {
            if (!(error instanceof CreditError))
                logger.error('Credit request failed:', error.message);
            res.status(error.status || 500).json({
                error: error.status
                    ? error.message
                    : 'Unable to update credits; please try again',
                ...(error.details || {}),
            });
        }
    };
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
        await credits.byCode(code);
        return appleSubscriptions.attach(code, req.body?.transactions);
    }));
    // Read-only membership lookup. A failed provider check must not hide credit balances.
    router.post(
        '/subscription',
        endpoint(async (req) => {
            const user = await credits.byCode(req.body?.code);
            const membership = await purchases.subscriptionStatus(user);
            return {
                status: membership.isPro ? 'active' : 'inactive',
                ...(membership.appleSubscriptionBound ? { appleSubscriptionBound: true, subscriptionIdentityVersion: 1 } : {}),
                ...(membership.sandbox ? { sandbox: true, allowanceEnabled: membership.isPro } : {}),
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
            const result = await purchases.sync(user, { required: true });
            const current = await credits.balance(code);
            return {
                ...current,
                creditsAdded: result.credits,
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
