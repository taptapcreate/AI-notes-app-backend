function billingControls(config) {
    return {
        showSubscriptions: config?.billingControls?.showSubscriptions !== false,
        showTopUpPacks: config?.billingControls?.showTopUpPacks !== false,
        usePrimarySubscriptionTracking: config?.billingControls?.usePrimarySubscriptionTracking !== false,
    };
}
module.exports = { billingControls };
