const DEFAULTS = Object.freeze({
    providers: ['OpenRouter', 'OpenAI'],
    cloudPdfProviders: ['Mistral'],
    recoveryMessage: 'Results are available for recovery for up to 24 hours.',
    details: 'Hosted on Render. Saved credentials are excluded. Nothing is posted back automatically.',
});

const shortText = (value, max, fallback) => typeof value === 'string' && value.trim() &&
    value.trim().length <= max ? value.trim() : fallback;
function providerNames(value, fallback) {
    if (!Array.isArray(value) || !value.length || value.length > 5 ||
        value.some(name => typeof name !== 'string' || !name.trim() || name.trim().length > 40)) return [...fallback];
    return [...new Set(value.map(name => name.trim()))];
}
function processingDisclosure(config = {}) {
    const value = config.processingDisclosure || {};
    return {
        providers: providerNames(value.providers, DEFAULTS.providers),
        cloudPdfProviders: providerNames(value.cloudPdfProviders, DEFAULTS.cloudPdfProviders),
        recoveryMessage: shortText(value.recoveryMessage, 140, DEFAULTS.recoveryMessage),
        details: shortText(value.details, 180, DEFAULTS.details),
    };
}
module.exports = { processingDisclosure };
