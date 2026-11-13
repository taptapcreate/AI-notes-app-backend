const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { fork, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const http = require('node:http');
const AppConfig = require('../models/AppConfig');
const User = require('../models/User');
const exec = promisify(execFile);
let mongo, temporary, configServer, configURL;
let configurableWelcomeCredits = true;
before(async () => {
    mongo = await MongoMemoryReplSet.create({ binary: { version: '8.0.17' }, replSet: { count: 1 } });
    await mongoose.connect(mongo.getUri(), { dbName: 'ai_notes_app' });
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-notes-credit-rollout-'));
    await Promise.all([AppConfig.init(), User.init()]);
    configServer = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(
            JSON.stringify({
                generationBillingVersion: 2,
                creditPolicyVersion: 'one-time-v1',
                welcomeCreditsConfigurable: configurableWelcomeCredits,
            }),
        );
    });
    configServer.listen(0, '127.0.0.1');
    await once(configServer, 'listening');
    configURL = `http://127.0.0.1:${configServer.address().port}`;
});
after(async () => {
    await new Promise((resolve) => configServer.close(resolve));
    await mongoose.disconnect();
    await mongo?.stop();
    await fs.rm(temporary, { recursive: true, force: true });
});
const environment = () => ({
    ...process.env,
    MONGODB_URI: mongo.getUri(),
    CREDIT_POLICY_API_URL: configURL,
    OPEN_ROUTER_API_KEY: 'test-key',
    REVENUECAT_API_SECRET_KEY: '',
    REVENUECAT_WEBHOOK_SECRET: '',
    ADMIN_API_SECRET: '',
    PORT: '0',
});

test('policy inspection is read-only; apply preserves versions, balances, and other settings', async () => {
    await AppConfig.create({
        key: 'master_config',
        dailyFreeCreditsEnabled: true,
        freeDailyCredits: 2,
        welcomePackCredits: 8,
        welcomePackVersion: 4,
        globalAlert: { active: true, title: 'Keep me' },
    });
    await User.create([
        { recoveryCode: 'DAILYAAA', credits: 50, freeCreditsRemaining: 1 },
        {
            recoveryCode: 'PACKAAAA',
            credits: 100,
            totalFreeCredits: 2,
            welcomePackVersion: 1,
        },
        {
            recoveryCode: 'SPENTAAA',
            credits: 20,
            totalFreeCredits: 0,
            welcomePackVersion: 1,
        },
    ]);
    const beforeUsers = JSON.stringify(await User.find().sort({ recoveryCode: 1 }).lean());
    const script = path.resolve(__dirname, '../scripts/one-time-credits.js');
    const run = async (args) => {
        const { stdout } = await exec(process.execPath, [script, ...args], {
            cwd: temporary,
            env: environment(),
        });
        return JSON.parse(stdout);
    };
    const inspected = await run([]);
    assert.equal(inspected.mode, 'dry-run');
    assert.equal(inspected.eligibleForOneTimeGrant, 1);
    assert.equal((await AppConfig.findOne()).dailyFreeCreditsEnabled, true);
    assert.equal(JSON.stringify(await User.find().sort({ recoveryCode: 1 }).lean()), beforeUsers);
    await assert.rejects(run(['--apply']), /clients-ready/);
    configurableWelcomeCredits = false;
    await assert.rejects(run(['--apply', '--clients-ready']), /Deploy the updated backend/);
    assert.equal((await AppConfig.findOne()).dailyFreeCreditsEnabled, true);
    configurableWelcomeCredits = true;
    const applied = await run(['--apply', '--clients-ready']);
    assert.equal(applied.applied, true);
    const config = await AppConfig.findOne();
    assert.equal(config.dailyFreeCreditsEnabled, false);
    assert.equal(config.generationBillingRequired, true);
    assert.equal(config.welcomePackCredits, 8);
    assert.equal(config.welcomePackVersion, 4);
    assert.equal(config.freeDailyCredits, 2);
    assert.equal(config.globalAlert.title, 'Keep me');
    assert.equal(JSON.stringify(await User.find().sort({ recoveryCode: 1 }).lean()), beforeUsers);
    const backup = JSON.parse(await fs.readFile(applied.backup, 'utf8'));
    assert.equal(backup.dailyFreeCreditsEnabled, true);
    assert.equal((await fs.stat(applied.backup)).mode & 0o777, 0o600);
    await run(['--apply', '--clients-ready']);
    assert.equal(JSON.stringify(await User.find().sort({ recoveryCode: 1 }).lean()), beforeUsers);
});

test('the real application boots and mounts fixed routes without AI or external purchase calls', async (t) => {
    const child = fork(path.resolve(__dirname, 'fixtures/server.cjs'), [], {
        cwd: temporary,
        env: { ...environment(), AI_NOTES_TEST_WEB: '1', REVENUECAT_API_SECRET_KEY: 'fixture-key' },
        silent: true,
    });
    let errors = '';
    child.stderr.on('data', (chunk) => {
        errors += chunk;
    });
    t.after(async () => {
        if (child.exitCode === null) {
            const done = once(child, 'exit');
            child.send('stop');
            await done;
        }
    });
    const [{ port }] = await Promise.race([
        once(child, 'message'),
        once(child, 'exit').then(() => {
            throw new Error(`Server exited early: ${errors}`);
        }),
    ]);
    const request = async (endpoint, body) => {
        const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
            method: body ? 'POST' : 'GET',
            headers: { 'Content-Type': 'application/json' },
            ...(body ? { body: JSON.stringify(body) } : {}),
        });
        return { status: response.status, body: await response.json() };
    };
    assert.equal((await request('/api/health')).body.status, 'ok');
    const config = await request('/api/config');
    assert.equal(config.body.dailyFreeCreditsEnabled, false);
    assert.equal(config.body.welcomePackCredits, 8);
    assert.equal(config.body.welcomeCreditsConfigurable, true);
    assert.equal(config.body.ios.storeUrl, 'https://apps.apple.com/app/id6757496314');
    assert.equal(config.body.android.latestVersion, '1.0.0');
    assert.equal(config.body.android.forceUpdate, false);
    assert.equal(config.body.creditPolicyVersion, 'one-time-v1');
    assert.equal(config.body.generationBillingRequired, true);
    assert.equal(
        (await request('/api/notes', { type: 'text', content: 'Must update' })).status,
        426,
    );
    const balance = await request('/api/credits/balance/DAILYAAA');
    assert.equal(balance.body.freeCreditsRemaining, 8);
    assert.equal(balance.body.credits, 50);
    const used = await request('/api/credits/use', {
        code: 'DAILYAAA',
        amount: 8,
    });
    assert.equal(used.body.remainingFreeCredits, 0);
    const recovered = await request('/api/credits/recover', {
        code: 'DAILYAAA',
        currentCode: 'PACKAAAA',
    });
    assert.equal(recovered.body.freeCreditsRemaining, 0);
    assert.equal(await User.countDocuments(), 3);
    assert.equal((await request('/api/admin/pending-purchases')).status, 503);
    assert.equal(
        (
            await request('/api/credits/add', {
                code: 'DAILYAAA',
                credits: 5000,
                transactionId: 'fake',
            })
        ).status,
        503,
    );
    // A restricted article must fail before AI runs, with no net wallet debit.
    for (const path of ['blocked', 'interstitial']) {
        const blocked = await fetch(`http://127.0.0.1:${port}/api/notes`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer DAILYAAA',
                'Idempotency-Key': randomUUID(),
            },
            body: JSON.stringify({ type: 'website', content: `https://example.com/${path}` }),
        });
        const rejected = await blocked.json();
        assert.equal(blocked.status, 502, rejected.error);
        assert.match(rejected.error, /^WEB_ACCESS_BLOCKED:/);
        assert.equal(rejected.billing.charged, false);
        assert.equal(rejected.billing.creditBalance.credits, 50);
        assert.equal((await User.findOne({ recoveryCode: 'DAILYAAA' })).credits, 50);
    }
    await AppConfig.updateOne(
        { key: 'master_config' },
        { $set: { macos: { minVersion: '1.0.1', latestVersion: '1.0.2' } } },
    );
    const versions = (await request('/api/config')).body;
    assert.equal(versions.macos.minVersion, '1.0.1');
    assert.equal(versions.macos.latestVersion, '1.0.2');
    assert.equal(versions.ios.minVersion, '1.0.0');
    // Simulate editing master_config while this same server process stays running.
    await AppConfig.updateOne({ key: 'master_config' }, { $set: { welcomePackCredits: 15 } });
    assert.equal((await request('/api/config')).body.welcomePackCredits, 15);
    const newUser = await request('/api/credits/register', {
        platform: 'android',
        deviceId: 'dynamic-policy-account',
    });
    assert.equal(newUser.body.freeCreditsRemaining, 15);
    assert.equal(newUser.body.welcomePackCredits, 15);
    assert.equal((await request('/api/credits/balance/DAILYAAA')).body.freeCreditsRemaining, 0);

    await AppConfig.updateOne({ key: 'master_config' }, { $set: { welcomePackCredits: 0 } });
    const zeroUser = await request('/api/credits/register', {
        platform: 'android',
        deviceId: 'zero-policy-account',
    });
    assert.equal(zeroUser.body.freeCreditsRemaining, 0);
    await AppConfig.updateOne({ key: 'master_config' }, { $set: { welcomePackCredits: 12 } });
    const zeroAgain = await request('/api/credits/register', {
        platform: 'android',
        deviceId: 'zero-policy-account',
    });
    assert.equal(zeroAgain.body.freeCreditsRemaining, 0);
    assert.equal(zeroAgain.body.welcomePackCredits, 12);

    await AppConfig.collection.updateOne(
        { key: 'master_config' },
        { $set: { welcomePackCredits: -5 } },
    );
    assert.equal((await request('/api/config')).status, 503);
    assert.equal(
        (await request('/api/credits/register', { deviceId: 'invalid-policy-account' })).status,
        503,
    );
    await AppConfig.updateOne({ key: 'master_config' }, { $set: { welcomePackCredits: 12 } });
});
