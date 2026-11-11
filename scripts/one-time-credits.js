// Default: inspect only. --apply changes policy, never bulk-resets user balances.
require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('node:fs/promises');
const path = require('node:path');
const AppConfig = require('../models/AppConfig');
const User = require('../models/User');
const { WELCOME_CREDITS } = require('../services/credit-policy');

async function main() {
    const args = process.argv.slice(2);
    if (
        args.some(
            (arg) => !['--apply', '--dry-run', '--clients-ready'].includes(arg),
        ) ||
        (args.includes('--apply') && args.includes('--dry-run'))
    ) {
        throw new Error(
            'Usage: npm run credits:policy -- [--dry-run | --apply --clients-ready]',
        );
    }
    if (args.includes('--apply')) {
        if (!args.includes('--clients-ready'))
            throw new Error(
                'Release the updated mobile clients first, then apply with --clients-ready. No policy was changed.',
            );
        const apiURL =
            process.env.CREDIT_POLICY_API_URL ||
            'https://ai-notes-app-backend-h9r0.onrender.com/api';
        const response = await fetch(`${apiURL.replace(/\/$/, '')}/config`, {
            signal: AbortSignal.timeout(60000),
        });
        const deployed = response.ok ? await response.json() : null;
        if (
            deployed?.generationBillingVersion !== 2 ||
            deployed?.creditPolicyVersion !== 'one-time-v1'
        )
            throw new Error(
                'Deploy the updated backend before switching credit policy. No policy was changed.',
            );
    }
    if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');
    await mongoose.connect(process.env.MONGODB_URI, {
        dbName: 'ai_notes_app',
        autoIndex: false,
    });
    const config = await AppConfig.findOne({ key: 'master_config' }).lean();
    if (!config)
        throw new Error(
            'Existing master_config not found; no settings were changed',
        );
    const report = {
        mode: args.includes('--apply') ? 'apply' : 'dry-run',
        database: 'ai_notes_app',
        current: {
            dailyFreeCreditsEnabled: config.dailyFreeCreditsEnabled,
            welcomePackCredits: config.welcomePackCredits,
            welcomePackVersion: config.welcomePackVersion,
        },
        proposed: {
            dailyFreeCreditsEnabled: false,
            welcomePackCredits: WELCOME_CREDITS,
            generationBillingRequired: true,
            welcomePackVersion: config.welcomePackVersion,
        },
        users: await User.countDocuments(),
        eligibleForOneTimeGrant: await User.countDocuments({
            welcomeGrantClaimedAt: null,
            $and: [
                {
                    $or: [
                        { welcomePackVersion: { $exists: false } },
                        { welcomePackVersion: { $lte: 0 } },
                    ],
                },
                {
                    $or: [
                        { totalFreeCredits: { $exists: false } },
                        { totalFreeCredits: { $lte: 0 } },
                    ],
                },
            ],
        }),
    };
    if (args.includes('--apply')) {
        const directory = path.resolve('backups');
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        const backup = path.join(directory, `credit-policy-${Date.now()}.json`);
        await fs.writeFile(backup, JSON.stringify(config, null, 2), {
            mode: 0o600,
            flag: 'wx',
        });
        const expected = (field) =>
            config[field] === undefined ? { $exists: false } : config[field];
        const result = await AppConfig.updateOne(
            {
                _id: config._id,
                dailyFreeCreditsEnabled: expected('dailyFreeCreditsEnabled'),
                welcomePackCredits: expected('welcomePackCredits'),
                welcomePackVersion: expected('welcomePackVersion'),
                generationBillingRequired: expected(
                    'generationBillingRequired',
                ),
            },
            {
                $set: {
                    dailyFreeCreditsEnabled: false,
                    welcomePackCredits: WELCOME_CREDITS,
                    generationBillingRequired: true,
                    updatedAt: new Date(),
                },
            },
        );
        if (!result.matchedCount)
            throw new Error(
                'Configuration changed during review; inspect again before applying',
            );
        report.applied = true;
        report.backup = backup;
    }
    console.log(JSON.stringify(report, null, 2));
}

main()
    .catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    })
    .finally(() => mongoose.disconnect());
