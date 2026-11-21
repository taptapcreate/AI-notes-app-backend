const { test } = require('node:test');
const assert = require('node:assert/strict');
const { attachmentKey, createAttachmentCache } = require('../services/attachment-cache');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('attachment keys distinguish bytes, account, model, format and processing version', () => {
    const key = attachmentKey('account-a', ['audio-v1', 'model-a', 'wav'], Buffer.from('recording-a'));
    assert.equal(key, attachmentKey('account-a', ['audio-v1', 'model-a', 'wav'], Buffer.from('recording-a')));
    for (const [scope, settings, content] of [
        ['account-b', ['audio-v1', 'model-a', 'wav'], 'recording-a'],
        ['account-a', ['audio-v1', 'model-a', 'wav'], 'recording-b'],
        ['account-a', ['audio-v1', 'model-b', 'wav'], 'recording-a'],
        ['account-a', ['audio-v2', 'model-a', 'wav'], 'recording-a'],
        ['account-a', ['audio-v1', 'model-a', 'mp3'], 'recording-a'],
    ]) assert.notEqual(key, attachmentKey(scope, settings, Buffer.from(content)));
    assert.equal(attachmentKey(undefined, [], Buffer.from('recording-a')), null);
    assert.doesNotMatch(key, /account|recording/);
});

test('successful values are isolated from mutation and expire without extending their TTL', t => {
    let time = 0;
    const cache = createAttachmentCache({ now: () => time, ttlMs: 1000 }); t.after(() => cache.dispose());
    const value = { text: 'first' }; cache.set('a', value); value.text = 'mutated';
    const hit = cache.get('a'); assert.equal(hit.text, 'first'); hit.text = 'changed';
    time = 999; assert.equal(cache.get('a').text, 'first');
    time = 1000; assert.equal(cache.get('a'), undefined);
});

test('LRU entry and byte budgets evict safely and oversized results do not replace valid values', t => {
    const cache = createAttachmentCache({ maxEntries: 2, maxBytes: 20, maxEntryBytes: 10 }); t.after(() => cache.dispose());
    cache.set('a', 'one'); cache.set('b', 'two'); cache.get('a'); cache.set('c', 'three');
    assert.equal(cache.get('b'), undefined); assert.equal(cache.get('a'), 'one');
    cache.set('a', 'too large to cache'); assert.equal(cache.get('a'), 'one');
    cache.set('d', '12345678'); cache.set('e', '12345678');
    assert.equal(cache.get('d'), '12345678'); assert.equal(cache.get('e'), '12345678');
    assert.equal(cache.get('a'), undefined);
});

test('identical concurrent extraction is shared; one cancelled caller does not cancel another', async t => {
    const cache = createAttachmentCache(); t.after(() => cache.dispose());
    const ready = deferred(), a = new AbortController(); let calls = 0, upstream;
    const work = signal => { calls++; upstream = signal; return ready.promise; };
    const first = cache.run('a', work, a.signal); const second = cache.run('a', work);
    await new Promise(resolve => setImmediate(resolve)); a.abort();
    await assert.rejects(first, { name: 'AbortError' }); assert.equal(upstream.aborted, false);
    ready.resolve('correct transcript'); assert.equal(await second, 'correct transcript');
    assert.equal(await cache.run('a', () => assert.fail('unexpected repeat')), 'correct transcript');
    assert.equal(calls, 1);
});

test('all cancelled callers abort upstream and late output cannot populate or overwrite a new attempt', async t => {
    const cache = createAttachmentCache(); t.after(() => cache.dispose());
    const first = deferred(), second = deferred(), caller = new AbortController(); let upstream;
    const abandoned = cache.run('same', signal => { upstream = signal; return first.promise; }, caller.signal);
    await new Promise(resolve => setImmediate(resolve)); caller.abort();
    await assert.rejects(abandoned, { name: 'AbortError' }); assert.equal(upstream.aborted, true);
    const current = cache.run('same', () => second.promise);
    first.resolve('late obsolete transcript'); second.resolve('new verified transcript');
    assert.equal(await current, 'new verified transcript');
    assert.equal(cache.get('same'), 'new verified transcript');
});

test('errors, missing scope and already-aborted calls cannot become cached results', async t => {
    const cache = createAttachmentCache(); t.after(() => cache.dispose()); let calls = 0;
    await assert.rejects(cache.run('a', () => { throw new Error('provider failed'); }), /provider failed/);
    assert.equal(await cache.run('a', () => 'retry succeeds'), 'retry succeeds');
    for (let i = 0; i < 2; i++) await cache.run(null, () => { calls++; return 'uncached'; });
    const abort = new AbortController(); abort.abort();
    await assert.rejects(cache.run('new', () => assert.fail('must not start'), abort.signal), { name: 'AbortError' });
    assert.equal(calls, 2);
});

test('pending extraction has a bound and bypass does not mix distinct keys', async t => {
    const cache = createAttachmentCache({ maxPending: 1 }); t.after(() => cache.dispose());
    const held = deferred(); const first = cache.run('first', () => held.promise);
    assert.equal(await cache.run('second', () => 'second file'), 'second file');
    assert.equal(cache.get('second'), undefined);
    held.resolve('first file'); assert.equal(await first, 'first file');
});
