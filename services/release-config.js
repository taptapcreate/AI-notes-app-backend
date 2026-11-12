const STORES = Object.freeze({
    ios: 'https://apps.apple.com/app/id6757496314',
    android: 'https://play.google.com/store/apps/details?id=com.taptapcreate.ainotes',
});
const validVersion = value => typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value);
function compare(a, b) {
    const left = a.split('.').map(Number), right = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
    return 0;
}
function storeURL(value, platform) {
    try {
        const url = new URL(value);
        if (url.protocol === 'https:' && url.hostname === (platform === 'ios' ? 'apps.apple.com' : 'play.google.com') &&
            !url.username && !url.password && !value.includes('...')) return value;
    } catch { /* Use the app's official store URL. */ }
    return STORES[platform];
}
function releaseConfig(config) {
    return Object.fromEntries(['ios', 'android'].map(platform => {
        const settings = config[platform] || {};
        const minVersion = validVersion(settings.minVersion) ? settings.minVersion
            : validVersion(config.minAppVersion) ? config.minAppVersion : '1.0.0';
        let latestVersion = validVersion(settings.latestVersion) ? settings.latestVersion
            : validVersion(config.latestAppVersion) ? config.latestAppVersion : minVersion;
        if (compare(latestVersion, minVersion) < 0) latestVersion = minVersion;
        // Old clients only understand latestVersion + forceUpdate. New clients use minVersion.
        return [platform, {
            minVersion,
            latestVersion,
            forceUpdate: settings.forceUpdate === true || compare(minVersion, '1.0.0') > 0,
            forceLatest: settings.forceUpdate === true,
            storeUrl: storeURL(settings.storeUrl || config.updateUrl, platform),
            releaseNotes: Array.isArray(settings.releaseNotes) ? settings.releaseNotes.filter(note => typeof note === 'string' && note.trim()).slice(0, 10) : [],
        }];
    }));
}
module.exports = { releaseConfig };
