// Add discoverable controls without changing any existing operator setting.
async function initializeMessageControls({ Config, Messages }) {
    const filter = { key: 'master_config' };
    const config = await Config.collection.findOne(filter);
    if (!config) return;
    const defaults = {
        enabled: config.globalAlert?.active === true && config.globalAlert?.isBlocking === true,
        title: config.globalAlert?.isBlocking ? config.globalAlert.title || 'We’ll be back soon' : 'We’ll be back soon',
        message: config.globalAlert?.isBlocking ? config.globalAlert.message || 'AI Notes is undergoing maintenance. Please try again shortly.' : 'AI Notes is undergoing maintenance. Please try again shortly.',
        platforms: { ios: { enabled: false }, android: { enabled: false }, macos: { enabled: false } },
    };
    if (config.maintenance == null) {
        await Config.collection.updateOne({ ...filter, maintenance: null }, { $set: { maintenance: defaults } });
    } else {
        for (const [name, value] of Object.entries(defaults)) {
            if (name === 'platforms') continue;
            const field = `maintenance.${name}`;
            await Config.collection.updateOne({ ...filter, [field]: { $exists: false } }, { $set: { [field]: value } });
        }
        await Config.collection.updateOne({ ...filter, 'maintenance.platforms': null }, { $set: { 'maintenance.platforms': defaults.platforms } });
        for (const platform of ['ios', 'android', 'macos']) {
            const parent = `maintenance.platforms.${platform}`;
            await Config.collection.updateOne({ ...filter, [parent]: null }, { $set: { [parent]: { enabled: false } } });
            const field = `maintenance.platforms.${platform}.enabled`;
            await Config.collection.updateOne({ ...filter, [field]: { $exists: false } }, { $set: { [field]: false } });
        }
    }
    await Messages.init();
}
module.exports = { initializeMessageControls };
