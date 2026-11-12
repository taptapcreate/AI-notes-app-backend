const { timingSafeEqual } = require('node:crypto');
const {
    CREDIT_PACK_PRODUCTS,
    purchaseAliases,
} = require('../services/purchases');

function authorized(header, secret) {
    if (typeof secret !== 'string' || !secret || typeof header !== 'string')
        return false;
    const value = header.startsWith('Bearer ') ? header.slice(7) : header;
    const a = Buffer.from(value);
    const b = Buffer.from(secret);
    return a.length === b.length && timingSafeEqual(a, b);
}

function createRevenueCatHandler({
    User,
    PendingPurchase,
    credits,
    reconcilePurchases = async () => {},
    subscriptionEvent = async () => false,
    allowSandbox = false,
    secret,
    notify = async () => {},
    logger = console,
}) {
    return async (req, res) => {
        try {
            if (!secret)
                return res
                    .status(503)
                    .json({ error: 'Purchase webhook is not configured' });
            if (!authorized(req.headers.authorization, secret))
                return res.status(401).json({ error: 'Unauthorized' });
            const event = req.body?.event;
            if (!event || typeof event.type !== 'string')
                return res.status(400).json({ error: 'Invalid event' });
            if (await subscriptionEvent(event)) return res.json({ success: true, message: 'Subscription updated' });
            if (
                !['INITIAL_PURCHASE', 'NON_RENEWING_PURCHASE'].includes(
                    event.type,
                )
            ) {
                return res.json({ success: true, message: 'Event ignored' });
            }
            const amount = CREDIT_PACK_PRODUCTS[event.product_id];
            if (!amount || (event.environment === 'SANDBOX' && !allowSandbox)) {
                return res.json({ success: true, message: 'Event ignored' });
            }
            if (
                typeof event.app_user_id !== 'string' ||
                !event.app_user_id.trim() ||
                event.app_user_id.length > 512 ||
                typeof event.transaction_id !== 'string' ||
                !event.transaction_id ||
                event.transaction_id.length > 512
            ) {
                return res
                    .status(400)
                    .json({ error: 'Purchase identity is required' });
            }
            const user = await User.findOne({
                recoveryCode: event.app_user_id.toUpperCase(),
            }).lean();
            if (!user) {
                // The unique transaction index makes duplicate webhook delivery safe.
                try {
                    await PendingPurchase.updateOne(
                        { transactionId: event.transaction_id },
                        {
                            $setOnInsert: {
                                rcAppUserId: event.app_user_id,
                                productId: event.product_id,
                                transactionId: event.transaction_id,
                                credits: amount,
                                rawEvent: event,
                            },
                        },
                        { upsert: true },
                    );
                } catch (error) {
                    if (error.code !== 11000) throw error;
                }
                return res.json({
                    success: true,
                    message: 'Stored as pending purchase',
                    pendingCredits: amount,
                });
            }
            // Reconcile legacy RevenueCat IDs before considering the webhook's
            // store ID. Old installations recorded only one of those identities.
            await reconcilePurchases(user);
            const aliases = purchaseAliases(event.product_id, event);
            const result = await credits.grantPurchase(
                user.recoveryCode,
                aliases,
                amount,
                'revenuecat_webhook',
            );
            if (result.applied) {
                try {
                    await notify(
                        user.recoveryCode,
                        amount,
                        result.user.credits,
                    );
                } catch (error) {
                    logger.warn(
                        'Purchase notification deferred:',
                        error.message,
                    );
                }
            }
            return res.json({
                success: true,
                alreadyProcessed: !result.applied,
            });
        } catch (error) {
            logger.error('Purchase webhook failed:', error.message);
            return res
                .status(error.status || 500)
                .json({
                    error: error.status
                        ? error.message
                        : 'Failed to process webhook',
                });
        }
    };
}

module.exports = { authorized, createRevenueCatHandler };
