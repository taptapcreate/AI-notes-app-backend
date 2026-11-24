const DEFAULT_HELP_SUPPORT = Object.freeze({
    enabled: false,
    title: 'More help',
    message: 'Need help with a feature, purchase, or technical issue? You can send us a query through our support website.',
    buttonLabel: 'Visit support website',
    url: '',
});
const limits = { title: 80, message: 600, buttonLabel: 40, url: 2048 };
function supportURL(value) {
    if (typeof value !== 'string' || value.length > limits.url) return '';
    try {
        const url = new URL(value.trim());
        if (url.protocol === 'https:' && url.hostname && !url.username && !url.password) return url.href;
    } catch { /* An unset or invalid URL keeps the website button unavailable. */ }
    return '';
}
function helpSupport(config = {}) {
    const value = config.helpSupport || {};
    const text = key => typeof value[key] === 'string' && value[key].trim() && value[key].trim().length <= limits[key]
        ? value[key].trim() : DEFAULT_HELP_SUPPORT[key];
    return { enabled: value.enabled === true,
        title: text('title'), message: text('message'), buttonLabel: text('buttonLabel'),
        url: supportURL(value.url) };
}
async function initializeHelpSupport(Config) {
    // Seed only missing fields. A database false or custom text must survive every restart.
    await Config.collection.bulkWrite(Object.entries(DEFAULT_HELP_SUPPORT).map(([key, value]) => ({
        updateOne: { filter: { key: 'master_config', ['helpSupport.' + key]: { $exists: false } },
            update: { $set: { ['helpSupport.' + key]: value } } },
    })));
}
module.exports = { DEFAULT_HELP_SUPPORT, limits, supportURL, helpSupport, initializeHelpSupport };
