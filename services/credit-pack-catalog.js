const { createHash } = require('node:crypto');
const { CreditError } = require('./credit-policy');

// Defaults belong only to the server. Clients receive the current catalog.
const IDS = ['lite', 'power', 'pro', 'elite', 'ultimate', 'mega', 'supreme']
    .map(name => `ai_notes_${name}_pack_credits`);
const amounts = values => Object.fromEntries(IDS.map((id, index) => [id, values[index]]));
const LEGACY = amounts([100, 350, 550, 900, 1800, 3500, 5000]);
const DEFAULTS = amounts([20, 50, 100, 200, 350, 750, 1500]);
const PLATFORMS = ['ios', 'macos', 'android', 'windows'];
const fingerprint = credits => createHash('sha256').update(JSON.stringify(credits)).digest('hex');

function configuredAmounts(config, platform) {
    const overrides = ['android', 'windows'].includes(platform) ? config.creditPacks?.platforms?.[platform] : null;
    const common = config.creditPacks?.amounts;
    return Object.fromEntries(IDS.map(id => {
        const value = overrides?.[id] ?? common?.[id] ?? (platform === 'android' ? LEGACY : DEFAULTS)[id];
        if (!Number.isSafeInteger(value) || value < 1 || value > 100000)
            throw new CreditError(503, 'Credit-pack configuration needs attention');
        return [id, value];
    }));
}

function createCreditPackCatalog({ History, getAppConfig, now = () => new Date() }) {
    async function current(platform, suppliedConfig) {
        if (!PLATFORMS.includes(platform)) throw new CreditError(400, 'Unknown purchase platform');
        const config = suppliedConfig ?? await getAppConfig();
        const credits = configuredAmounts(config, platform);
        const key = ['ios', 'macos'].includes(platform) ? 'apple' : platform;
        const hash = fingerprint(credits);
        // Each platform has one atomically versioned history. Never rewrite an
        // earlier revision: delayed receipts must receive their original amount.
        for (let attempt = 0; attempt < 8; attempt++) {
            let state = await History.findById(key).lean();
            if (!state) {
                const time = now();
                const legacy = { effectiveAt: new Date(0), credits: LEGACY, hash: fingerprint(LEGACY) };
                const initial = { effectiveAt: time, credits, hash };
                try {
                    await History.updateOne({ _id: key }, { $setOnInsert: {
                        version: 1, revisions: [legacy, initial],
                    } }, { upsert: true });
                } catch (error) { if (error.code !== 11000) throw error; }
                continue;
            }
            const latest = state.revisions.at(-1);
            if (latest.hash === hash) return {
                revision: `${key}:${state.version}`, effectiveAt: latest.effectiveAt, credits: latest.credits,
            };
            const time = new Date(Math.max(now().getTime(), new Date(latest.effectiveAt).getTime() + 1));
            const updated = await History.findOneAndUpdate({ _id: key, version: state.version }, {
                $push: { revisions: { effectiveAt: time, credits, hash } }, $inc: { version: 1 },
            }, { returnDocument: 'after' }).lean();
            if (updated) return { revision: `${key}:${updated.version}`, effectiveAt: time, credits };
        }
        throw new CreditError(503, 'Credit packs are updating. Please reload prices.');
    }
    async function amount(product, purchase) {
        if (!IDS.includes(product)) return undefined;
        const platform = { app_store: 'ios', mac_app_store: 'macos', play_store: 'android' }
            [String(purchase?.store || '').toLowerCase()];
        if (!platform) return undefined;
        const date = purchase.purchased_at_ms ?? purchase.purchase_date;
        const time = typeof date === 'string' ? Date.parse(date) : date;
        if (!Number.isSafeInteger(time) || time <= 0 || time > now().getTime() + 300000) return undefined;
        await current(platform);
        const key = ['ios', 'macos'].includes(platform) ? 'apple' : platform;
        const state = await History.findById(key).lean();
        return [...state.revisions].reverse().find(entry => new Date(entry.effectiveAt).getTime() <= time)?.credits[product];
    }
    async function publicCatalog(config) {
        config ??= await getAppConfig();
        const [apple, android, windows] = await Promise.all(
            ['ios', 'android', 'windows'].map(platform => current(platform, config)),
        );
        return { version: 1, platforms: {
            ios: apple, macos: { ...apple, credits: { ...apple.credits } }, android, windows,
        } };
    }
    return { current, amount, publicCatalog };
}

async function initializeCreditPacks(Config) {
    for (const [path, value] of [
        ...Object.entries(DEFAULTS).map(([id, amount]) => [`creditPacks.amounts.${id}`, amount]),
        ...Object.entries(LEGACY).map(([id, amount]) => [`creditPacks.platforms.android.${id}`, amount]),
    ]) {
        await Config.updateOne({ key: 'master_config', [path]: { $exists: false } }, { $set: { [path]: value } });
    }
}

module.exports = { initializeCreditPacks, IDS, DEFAULTS, LEGACY, PLATFORMS, configuredAmounts, createCreditPackCatalog };
