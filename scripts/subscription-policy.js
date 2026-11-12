require('dotenv').config();
const mongoose = require('mongoose');
const AppConfig = require('../models/AppConfig');
async function main() {
    const args = process.argv.slice(2);
    if (args.some(arg => !['--apply', '--dry-run'].includes(arg)) || args.length > 1)
        throw new Error('Use --dry-run or --apply');
    if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');
    await mongoose.connect(process.env.MONGODB_URI, { dbName: 'ai_notes_app', autoIndex: false, serverSelectionTimeoutMS: 10000 });
    const config = await AppConfig.findOne({ key: 'master_config' }).lean();
    if (!config) throw new Error('Existing master_config not found');
    const apply = args.includes('--apply');
    if (apply) await AppConfig.updateOne({ _id: config._id }, { $set: { subscriberDailyLimit: 10 } }, { runValidators: true });
    console.log(JSON.stringify({ applied: apply, previousLimit: config.subscriberDailyLimit, dailyLimit: 10 }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => mongoose.disconnect());
