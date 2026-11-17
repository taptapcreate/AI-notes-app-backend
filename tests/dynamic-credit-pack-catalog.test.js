const test = require('node:test');
const assert = require('node:assert/strict');
const { createCreditPackCatalog, configuredAmounts, DEFAULTS, LEGACY } = require('../services/credit-pack-catalog');
const id = 'ai_notes_lite_pack_credits';

function setup() {
    const records = new Map();
    let config = {};
    let time = new Date('2026-11-17T12:00:00Z');
    const copy = value => structuredClone(value);
    const History = {
        findById(key) { return { async lean() { return copy(records.get(key)); } }; },
        async updateOne(query, update) {
            if (!records.has(query._id)) records.set(query._id, copy({ _id: query._id, ...update.$setOnInsert }));
        },
        findOneAndUpdate(query, update) {
            return { async lean() {
                const record = records.get(query._id);
                if (record.version !== query.version) return null;
                record.version++;
                record.revisions.push(copy(update.$push.revisions));
                return copy(record);
            } };
        },
    };
    return {
        service: createCreditPackCatalog({ History, getAppConfig: async () => config, now: () => time }), records,
        change(credits) { config = { creditPacks: { amounts: { [id]: credits } } }; time = new Date(time.getTime() + 60000); },
    };
}

test('current Apple catalog and verified purchase grants use the same server quantity', async () => {
    const { service } = setup();
    const catalog = await service.publicCatalog({});
    for (const [store, platform] of [['APP_STORE', 'ios'], ['MAC_APP_STORE', 'macos'], ['PLAY_STORE', 'android']]) {
        const value = await service.amount(id, { store, purchased_at_ms: Date.parse('2026-11-17T12:00:01Z') });
        assert.equal(value, catalog.platforms[platform].credits[id]);
    }
    assert.equal(catalog.platforms.ios.credits[id], 20);
    assert.equal(catalog.platforms.android.credits[id], 100);
});

test('late receipts retain the historical amount before and after a catalog change', async () => {
    const h = setup();
    await h.service.current('ios');
    assert.equal(await h.service.amount(id, { store: 'app_store', purchase_date: '2026-11-16T12:00:00Z' }), 100);
    h.change(35);
    const quote = await h.service.current('ios');
    assert.equal(quote.credits[id], 35);
    assert.equal(await h.service.amount(id, { store: 'app_store', purchase_date: '2026-11-17T12:00:30Z' }), 20);
    assert.equal(await h.service.amount(id, { store: 'app_store', purchase_date: '2026-11-17T12:01:01Z' }), 35);
});

test('concurrent readers create one atomic revision and reverting amounts creates a new revision', async () => {
    const h = setup();
    await h.service.current('ios');
    h.change(40);
    const result = await Promise.all(Array.from({ length: 6 }, () => h.service.current('ios')));
    assert.deepEqual(new Set(result.map(r => r.revision)), new Set(['apple:2']));
    assert.equal(h.records.get('apple').revisions.length, 3);
    h.change(20);
    assert.equal((await h.service.current('ios')).revision, 'apple:3');
});

test('unverified stores, invalid dates, and unknown products cannot select a grant', async () => {
    const { service } = setup();
    for (const purchase of [{}, { store: 'invented', purchased_at_ms: 1 }, { store: 'app_store' },
        { store: 'app_store', purchased_at_ms: -1 }, { store: 'app_store', purchase_date: '2099-01-01' }])
        assert.equal(await service.amount(id, purchase), undefined);
    assert.equal(await service.amount('invented', { store: 'app_store', purchased_at_ms: 1 }), undefined);
});

test('platform overrides and bounds apply to displayed and granted quantities', () => {
    const config = { creditPacks: { amounts: { [id]: 30 }, platforms: { windows: { [id]: 45 } } } };
    assert.equal(configuredAmounts(config, 'ios')[id], 30);
    assert.equal(configuredAmounts(config, 'windows')[id], 45);
    for (const amount of [0, -1, 1.5, '40', 100001])
        assert.throws(() => configuredAmounts({ creditPacks: { amounts: { [id]: amount } } }, 'ios'));
    assert.deepEqual(configuredAmounts({}, 'ios'), DEFAULTS);
    assert.deepEqual(configuredAmounts({}, 'android'), LEGACY);
});
