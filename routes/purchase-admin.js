const express = require('express');
const { authorized } = require('./revenuecat');
const { recoveryCode, CreditError } = require('../services/credit-policy');
const {
    CREDIT_PACK_PRODUCTS,
    purchaseAliases,
} = require('../services/purchases');

function createPurchaseAdminRouter({
    PendingPurchase,
    credits,
    secret,
    logger = console,
}) {
    const router = express.Router();
    router.use((req, res, next) => {
        if (!secret)
            return res
                .status(503)
                .json({ error: 'Purchase administration is not configured' });
        if (!authorized(req.headers.authorization, secret))
            return res.status(401).json({ error: 'Unauthorized' });
        next();
    });
    router.get('/pending-purchases', async (req, res) => {
        try {
            const pending = await PendingPurchase.find({ status: 'pending' })
                .sort({ createdAt: -1 })
                .limit(100);
            res.json({
                success: true,
                count: pending.length,
                purchases: pending.map((p) => ({
                    id: p._id,
                    rcAppUserId: p.rcAppUserId,
                    productId: p.productId,
                    transactionId: p.transactionId,
                    credits: p.credits,
                    createdAt: p.createdAt,
                })),
            });
        } catch (error) {
            logger.error('Pending purchase lookup failed:', error.message);
            res.status(500).json({ error: 'Unable to read pending purchases' });
        }
    });
    router.post('/link-purchase', async (req, res) => {
        try {
            const code = recoveryCode(req.body?.recoveryCode);
            const id = req.body?.rcAppUserId;
            if (typeof id !== 'string' || !id.trim() || id.length > 512)
                throw new CreditError(
                    400,
                    'A valid RevenueCat user ID is required',
                );
            await credits.byCode(code);
            const pending = await PendingPurchase.find({
                rcAppUserId: id,
                status: 'pending',
            });
            let added = 0;
            let linked = 0;
            for (const purchase of pending) {
                const amount = CREDIT_PACK_PRODUCTS[purchase.productId];
                if (!amount)
                    throw new CreditError(
                        409,
                        'Unknown product requires manual review',
                    );
                const aliases = purchaseAliases(purchase.productId, {
                    ...(purchase.rawEvent || {}),
                    transaction_id: purchase.transactionId,
                });
                const result = await credits.grantPurchase(
                    code,
                    aliases,
                    amount,
                    'admin_link',
                );
                await PendingPurchase.updateOne(
                    { _id: purchase._id, status: 'pending' },
                    {
                        $set: {
                            status: 'processed',
                            linkedRecoveryCode: code,
                            processedAt: new Date(),
                        },
                    },
                );
                if (result.applied) {
                    added += amount;
                    linked++;
                }
            }
            res.json({
                success: true,
                purchasesLinked: linked,
                creditsAdded: added,
                newBalance: (await credits.byCode(code)).credits,
            });
        } catch (error) {
            logger.error('Pending purchase linking failed:', error.message);
            res.status(error.status || 500).json({
                error: error.status
                    ? error.message
                    : 'Unable to link pending purchases',
            });
        }
    });
    return router;
}

module.exports = { createPurchaseAdminRouter };
