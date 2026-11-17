const limits = {
    brief: { default: 1200, cap: 2000 },
    standard: { default: 2500, cap: 4000 },
    detailed: { default: 5000, cap: 6500 },
    'in-depth': { default: 6500, cap: 8000 },
};
const minimum = 128;

function noteOutputLimit(config, length) {
    const key = Object.hasOwn(limits, length) ? length : 'standard';
    const rule = limits[key];
    const value = config?.noteOutputTokenLimits?.[key];
    return Number.isSafeInteger(value) && value >= minimum ? Math.min(value, rule.cap) : rule.default;
}

async function initializeNoteOutputLimits(Config) {
    await Config.collection.bulkWrite(Object.entries(limits).map(([key, rule]) => {
        const path = 'noteOutputTokenLimits.' + key;
        return {
            updateOne: {
                filter: { key: 'master_config', [path]: { $exists: false } },
                update: { $set: { [path]: rule.default } },
            },
        };
    }));
}

module.exports = { limits, minimum, noteOutputLimit, initializeNoteOutputLimits };
