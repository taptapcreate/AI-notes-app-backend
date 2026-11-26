function billingControls(config) {
    return {
        showSubscriptions: config?.billingControls?.showSubscriptions !== false,
        showTopUpPacks: config?.billingControls?.showTopUpPacks !== false,
        usePrimarySubscriptionTracking: config?.billingControls?.usePrimarySubscriptionTracking !== false,
        showLifetimeFreeCredits: config?.billingControls?.showLifetimeFreeCredits !== false,
    };
}
function platformBillingControls(config) {
    return Object.fromEntries(['ios', 'android', 'macos', 'windows'].map(platform => [platform, {
        showSubscriptions: config?.platformBillingControls?.[platform]?.showSubscriptions !== false,
        showTopUpPacks: config?.platformBillingControls?.[platform]?.showTopUpPacks !== false,
    }]));
}
module.exports = { billingControls, platformBillingControls };
