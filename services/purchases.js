const { CreditError } = require('./credit-policy');
const { appleVerifier, BUNDLE_ID } = require('./apple-subscriptions');

const CREDIT_PACK_PRODUCTS = Object.freeze({
    ai_notes_lite_pack_credits: 100,
    ai_notes_power_pack_credits: 350,
    ai_notes_pro_pack_credits: 550,
    ai_notes_elite_pack_credits: 900,
    ai_notes_ultimate_pack_credits: 1800,
    ai_notes_mega_pack_credits: 3500,
    ai_notes_supreme_pack_credits: 5000,
});

function purchaseAliases(product, purchase) {
    const aliases = [
        purchase.store_transaction_id,
        purchase.transaction_id,
        purchase.id,
    ].filter(
        (value) =>
            typeof value === 'string' &&
            value.length > 0 &&
            value.length <= 512,
    );
    // Older RevenueCat responses may lack a store transaction ID. The store's
    // product + purchase timestamp also matches the corresponding webhook.
    const date = purchase.purchase_date ?? purchase.purchased_at_ms;
    const timestamp = date == null ? NaN : new Date(date).getTime();
    if (Number.isFinite(timestamp))
        aliases.push(
            `rc-purchase:${product}:${new Date(timestamp).toISOString()}`,
        );
    return [...new Set(aliases)];
}

function createPurchases({ credits, axios, apiKey, allowSandbox = false, appleSubscriptions, verifyApple }) {
    async function customer(user, { required = false } = {}) {
        if (!apiKey) {
            if (required)
                throw new CreditError(
                    503,
                    'Purchase verification is temporarily unavailable; your purchase can sync later',
                );
            return null;
        }
        let response;
        try {
            response = await axios.get(
                `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(user.recoveryCode)}`,
                {
                    timeout: 10000,
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        'Content-Type': 'application/json',
                    },
                },
            );
        } catch (error) {
            if (error.response?.status === 404) return null;
            throw new CreditError(
                503,
                'Purchase verification is temporarily unavailable; your purchase can sync later',
            );
        }
        const subscriber = response.data?.subscriber;
        if (
            !subscriber ||
            typeof subscriber !== 'object' ||
            Array.isArray(subscriber)
        )
            throw new CreditError(
                503,
                'Purchase verification returned an invalid response',
            );
        return subscriber;
    }
    async function subscriptionStatus(user) {
        const shared = await appleSubscriptions?.status(user);
        if (shared) return shared;
        const subscriber = await customer(user, { required: true });
        if (!subscriber) return { isPro: false };
        const products = new Set([
            'ai_notes_pro_weekly_subscription',
            'ai_notes_pro_monthly_subscription',
            'ai_notes_pro_weekly_subscription:ai-notes-pro-weekly-subscription',
            'ai_notes_pro_monthly_subscription:ai-notes-pro-monthly-subscription',
        ]);
        const entitlements = subscriber.entitlements || {};
        let sandboxMembership;
        for (const value of Object.values(entitlements)) {
            if (!value || !products.has(value.product_identifier)) continue;
            const subscription =
                subscriber.subscriptions?.[value.product_identifier] ||
                subscriber.subscriptions?.[
                    value.product_identifier.split(':')[0]
                ];
            if (subscription?.refunded_at) continue;
            const expiry = value.expires_date;
            const grace =
                value.grace_period_expires_date ||
                subscription?.grace_period_expires_date;
            if (
                expiry === null ||
                Date.parse(expiry) > Date.now() ||
                Date.parse(grace) > Date.now()
            ) {
                const membership = {
                    isPro: true,
                    plan: value.product_identifier.includes('monthly') ? 'monthly' : 'weekly',
                    expiresAt: Number.isFinite(Date.parse(expiry))
                        ? new Date(expiry).toISOString()
                        : null,
                };
                if (subscription?.is_sandbox !== true) return membership;
                sandboxMembership = {
                    ...membership,
                    sandbox: true,
                    isPro:
                        allowSandbox ||
                        subscription.store === 'app_store' ||
                        subscription.store === 'mac_app_store',
                };
            }
        }
        return sandboxMembership || { isPro: false };
    }
    async function sync(user, options = {}) {
        const subscriber = await customer(user, options);
        if (!subscriber) return { synced: 0, credits: 0 };
        const purchases = subscriber.non_subscriptions;
        if (
            !purchases ||
            typeof purchases !== 'object' ||
            Array.isArray(purchases)
        ) {
            throw new CreditError(
                503,
                'Purchase verification returned an invalid response',
            );
        }
        const expected = options.purchase;
        if (expected && (!CREDIT_PACK_PRODUCTS[expected.productId] ||
            typeof expected.transactionId !== 'string' || !expected.transactionId ||
            expected.transactionId.length > 512))
            throw new CreditError(400, 'Invalid purchase identity');
        let confirmation = expected ? { ...expected, status: 'pending' } : undefined;
        let synced = 0;
        let amount = 0;
        for (const [product, entries] of Object.entries(purchases)) {
            const value = CREDIT_PACK_PRODUCTS[product];
            if (!value || !Array.isArray(entries)) continue;
            for (const purchase of entries) {
                if (
                    !purchase ||
                    typeof purchase !== 'object' ||
                    purchase.refunded_at ||
                    purchase.refund_date
                )
                    continue;
                const aliases = purchaseAliases(product, purchase);
                if (!aliases.length) continue;
                const matches = expected && expected.productId === product &&
                    aliases.includes(expected.transactionId);
                if (purchase.is_sandbox && !allowSandbox && !['app_store', 'mac_app_store'].includes(purchase.store)) {
                    if (matches) confirmation = { ...expected, status: 'sandbox_disabled', sandbox: true };
                    continue;
                }
                let result;
                try {
                    result = await credits.grantPurchase(
                        user.recoveryCode,
                        aliases,
                        value,
                        'revenuecat_sync',
                    );
                } catch (error) {
                    // A restored Apple receipt may include historical packs already consumed
                    // by another AI Notes account. Keep their ownership; sync newer purchases.
                    if (error.status === 409 && error.details?.code === 'PURCHASE_OWNED_BY_ANOTHER_ACCOUNT') continue;
                    throw error;
                }
                if (matches) confirmation = { ...expected, status: 'credited',
                    credits: value, alreadyProcessed: !result.applied, sandbox: purchase.is_sandbox === true };
                if (result.applied) {
                    synced++;
                    amount += value;
                }
            }
        }
        return { synced, credits: amount, ...(expected ? { purchase: confirmation } : {}) };
    }
    async function confirmApple(user, signed, expected) {
        verifyApple ||= appleVerifier();
        const proof = await verifyApple(signed);
        const amount = CREDIT_PACK_PRODUCTS[proof.productId];
        if (!amount || proof.bundleId !== BUNDLE_ID || proof.type !== 'Consumable' ||
            proof.revocationDate || !['Sandbox', 'Production'].includes(proof.environment) ||
            !/^\d{1,40}$/.test(proof.transactionId || '') ||
            !Number.isSafeInteger(proof.purchaseDate) || proof.purchaseDate <= 0 ||
            proof.purchaseDate > Date.now() + 300000 ||
            expected?.productId !== proof.productId || expected?.transactionId !== proof.transactionId)
            throw new CreditError(400, 'Apple credit transaction does not match this purchase');
        const aliases = purchaseAliases(proof.productId, {
            store_transaction_id: proof.transactionId, purchased_at_ms: proof.purchaseDate,
        });
        const result = await credits.grantPurchase(user.recoveryCode, aliases, amount, 'apple_verified');
        return { credits: result.applied ? amount : 0, purchase: {
            productId: proof.productId, transactionId: proof.transactionId, status: 'credited',
            credits: amount, alreadyProcessed: !result.applied, sandbox: proof.environment === 'Sandbox',
        } };
    }
    return { sync, subscriptionStatus, confirmApple };
}

module.exports = { createPurchases, CREDIT_PACK_PRODUCTS, purchaseAliases };
