require('dotenv').config();
const mongoose = require('mongoose');
const AppConfig = require('../models/AppConfig');
const keys = ['showSubscriptions', 'showTopUpPacks', 'usePrimarySubscriptionTracking'];

async function main() {
    const args = process.argv.slice(2);
    if (args.length > 1 || args.some(arg => !['--apply', '--dry-run'].includes(arg)))
        throw new Error('Use --dry-run or --apply');
    if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');
    await mongoose.connect(process.env.MONGODB_URI, {
        dbName: 'ai_notes_app', autoIndex: false, serverSelectionTimeoutMS: 10000,
    });
    const collection = AppConfig.collection;
    const config = await collection.findOne({ key: 'master_config' });
    if (!config) throw new Error('Existing master_config not found');
    if (config.billingControls !== undefined &&
        (!config.billingControls || typeof config.billingControls !== 'object' || Array.isArray(config.billingControls)))
        throw new Error('The existing billingControls field needs review');
    const fields = keys.map(key => 'billingControls.' + key);
    for (const platform of ['ios', 'android', 'macos', 'windows']) {
        for (const key of ['showSubscriptions', 'showTopUpPacks']) {
            fields.push('platformBillingControls.' + platform + '.' + key);
        }
    }
    const missing = fields.filter(field => field.split('.').reduce((value, key) => value?.[key], config) === undefined);
    const apply = args.includes('--apply');
    if (apply) {
        for (const field of missing) {
            await collection.updateOne({ _id: config._id, [field]: { $exists: false } },
                { $set: { [field]: true } });
        }
    }
    const updated = await collection.findOne({ _id: config._id });
    console.log(JSON.stringify({ applied: apply, missing, billingControls: updated.billingControls || {}, platformBillingControls: updated.platformBillingControls || {} }));
}
main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
}).finally(() => mongoose.disconnect());
