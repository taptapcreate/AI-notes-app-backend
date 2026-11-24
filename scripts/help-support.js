require('dotenv').config();
const mongoose = require('mongoose');
const AppConfig = require('../models/AppConfig');
const { helpSupport, initializeHelpSupport } = require('../services/help-support');
async function main() {
    const args = process.argv.slice(2);
    if (args.some(arg => !['--apply', '--dry-run', '--enable', '--disable'].includes(arg)) ||
        (args.includes('--enable') && args.includes('--disable')) || (args.includes('--apply') && args.includes('--dry-run')))
        throw Error('Use --dry-run or --apply, optionally with --enable or --disable.');
    if (!process.env.MONGODB_URI) throw Error('MONGODB_URI is required');
    await mongoose.connect(process.env.MONGODB_URI, { dbName: 'ai_notes_app', autoIndex: false, serverSelectionTimeoutMS: 10000 });
    const config = await AppConfig.collection.findOne({ key: 'master_config' });
    if (!config) throw Error('Existing master_config not found; no settings were changed.');
    if (config.helpSupport !== undefined && (!config.helpSupport || typeof config.helpSupport !== 'object' || Array.isArray(config.helpSupport)))
        throw Error('The existing helpSupport value needs review; no settings were changed.');
    const apply = args.includes('--apply');
    if (apply) {
        await initializeHelpSupport(AppConfig);
        if (args.includes('--enable') || args.includes('--disable'))
            await AppConfig.collection.updateOne({ _id: config._id }, { $set: { 'helpSupport.enabled': args.includes('--enable') } });
    }
    const current = await AppConfig.collection.findOne({ _id: config._id });
    console.log(JSON.stringify({ applied: apply, database: 'ai_notes_app', collection: AppConfig.collection.name,
        helpSupport: helpSupport(current), persisted: current.helpSupport !== undefined }, null, 2));
}
main().catch(error => { console.error(error.message.replace(/mongodb(?:\+srv)?:\/\/[^\s]+/g, '[database URI]')); process.exitCode = 1; })
    .finally(() => mongoose.disconnect());
