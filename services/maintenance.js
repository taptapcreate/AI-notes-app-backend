const { requestPlatform } = require('./platform');
function maintenanceState(config, platform) {
    const setting = config?.maintenance;
    const explicit = typeof setting?.enabled === 'boolean';
    const legacy = config?.globalAlert;
    const globalEnabled = explicit ? setting.enabled : legacy?.active === true && legacy?.isBlocking === true;
    const key = platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : platform;
    const local = ['ios', 'android', 'macos'].includes(key) ? setting?.platforms?.[key] : undefined;
    const localEnabled = local?.enabled === true;
    const text = (value, fallback, max) => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : fallback;
    const fallbackTitle = text(explicit ? setting.title : legacy?.title, 'We’ll be back soon', 120);
    const fallbackMessage = text(explicit ? setting.message : legacy?.message, 'AI Notes is undergoing maintenance. Please try again shortly.', 2000);
    return { enabled: globalEnabled || localEnabled,
        title: !globalEnabled && localEnabled ? text(local.title, fallbackTitle, 120) : fallbackTitle,
        message: !globalEnabled && localEnabled ? text(local.message, fallbackMessage, 2000) : fallbackMessage };
}

function publicMaintenance(config) {
    const maintenance = maintenanceState(config);
    const alert = config.globalAlert || {};
    return { maintenance: { ...maintenance, ...(config.maintenance?.platforms ? { platforms: config.maintenance.platforms } : {}) }, globalAlert: maintenance.enabled
        ? { ...alert, active: true, isBlocking: true, title: maintenance.title, message: maintenance.message }
        : typeof config.maintenance?.enabled === 'boolean' && alert.isBlocking
            ? { ...alert, active: false, isBlocking: false } : alert };
}
function createMaintenanceGate({ getAppConfig }) {
    return async (req, res, next) => {
        const route = req.path.toLowerCase();
        // Keep polling, verified payment reconciliation, and operational recovery available.
        if (req.method === 'OPTIONS' || /^\/(?:config(?:\/|$)|health$|webhooks(?:\/|$)|admin(?:\/|$))/.test(route) ||
            /^\/credits\/(?:apple-subscription|add|balance\/[^/]+|subscription|transactions\/[^/]+|announcement)\/?$/.test(route)) return next();
        try {
            const maintenance = maintenanceState(await getAppConfig(), requestPlatform(req));
            if (!maintenance.enabled) return next();
            res.set('Cache-Control', 'no-store');
            res.set('Retry-After', '30');
            return res.status(503).json({ code: 'APP_MAINTENANCE', error: maintenance.message, maintenance });
        } catch {
            return res.status(503).json({ code: 'CONFIG_UNAVAILABLE', error: 'AI Notes settings are temporarily unavailable. Please try again.' });
        }
    };
}
module.exports = { maintenanceState, publicMaintenance, createMaintenanceGate };
