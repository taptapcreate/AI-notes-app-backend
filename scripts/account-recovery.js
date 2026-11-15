require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const Subscription = require('../models/AppleSubscription');
const Backup = require('../models/AccountRecovery');
const { backfillAccountRecovery } = require('../services/recovery-cutover');
async function main() {
    const args = process.argv.slice(2);
    if (args.some(arg => !['--apply', '--dry-run', '--writers-stopped'].includes(arg)) ||
        (args.includes('--apply') && args.includes('--dry-run')))
        throw new Error('Use --dry-run or --apply --writers-stopped');
    if (args.includes('--apply') && !args.includes('--writers-stopped'))
        throw new Error('Stop old backend writers before the first backup; use --apply --writers-stopped');
    if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');
    await mongoose.connect(process.env.MONGODB_URI, { dbName: 'ai_notes_app', serverSelectionTimeoutMS: 10000, autoIndex: false });
    if (args.includes('--apply')) console.log(JSON.stringify(await backfillAccountRecovery({ User, Subscription, Backup })));
    else console.log(JSON.stringify({ dryRun: true, wallets: await User.countDocuments(), subscriptions: await Subscription.countDocuments(), backups: await Backup.countDocuments() }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => mongoose.disconnect());
