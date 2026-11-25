const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createOpenRouter } = require('../services/openrouter');
const { createAttachmentCache } = require('../services/attachment-cache');
const { reusablePdfAnnotations } = require('../services/pdf-annotations');
const b64 = text => Buffer.from(text).toString('base64');
const pdf = text => ({ inlineData: { mimeType: 'application/pdf', data: b64('%PDF-1.7\n' + text) } });
const annotation = (text = 'parsed source') => [{ type: 'file', file: { hash: 'provider-file-hash', name: 'document.pdf',
    content: [{ type: 'text', text }, { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }] } }];
const completion = annotations => ({ choices: [{ message: { content: 'Current answer', annotations }, finish_reason: 'stop' }] });

test('voice reuse matches actual bytes and account, never a filename or the last recording', async t => {
    const cache = createAttachmentCache(); t.after(() => cache.dispose()); let scope = 'account-a', calls = 0;
    const router = createOpenRouter({ post: async (_path, { body }) => {
        calls++; return { text: Buffer.from(body.input_audio.data, 'base64').toString().slice(12) };
    } }, { getCacheScope: () => scope, attachmentCache: cache });
    const first = b64('RIFF0000WAVEfirst recording'), second = b64('RIFF0000WAVEother recording');
    assert.equal(await router.transcribe(first), 'first recording');
    assert.equal(await router.transcribe(second), 'other recording');
    assert.equal(await router.transcribe(first), 'first recording'); assert.equal(calls, 2);
    scope = 'account-b'; assert.equal(await router.transcribe(first), 'first recording'); assert.equal(calls, 3);
    scope = undefined; await router.transcribe(first); await router.transcribe(first); assert.equal(calls, 5);
});

test('empty speech and failed transcription are retried, not reused', async t => {
    const cache = createAttachmentCache(); t.after(() => cache.dispose()); let calls = 0;
    const router = createOpenRouter({ post: async () => { calls++; if (calls === 1) throw new Error('temporary failure'); return { text: calls === 2 ? ' ' : 'Recovered speech' }; } },
        { getCacheScope: () => 'account', attachmentCache: cache });
    const audio = b64('RIFF0000WAVEspeech');
    await assert.rejects(router.transcribe(audio), /temporary failure/);
    await assert.rejects(router.transcribe(audio), /No speech/);
    assert.equal(await router.transcribe(audio), 'Recovered speech'); assert.equal(calls, 3);
});

test('PDF reuse keeps current instructions and images, and changing bytes or account misses the cache', async t => {
    const cache = createAttachmentCache(); t.after(() => cache.dispose()); let scope = 'a'; const requests = [];
    const router = createOpenRouter({ chat: { completions: { create: async body => { requests.push(body); return completion(annotation()); } } } },
        { getCacheScope: () => scope, attachmentCache: cache });
    await router.complete(['First question', pdf('file one')], 500);
    await router.complete(['A different question in Hindi', pdf('file one')], 900);
    assert.equal(requests[0].messages.length, 1); assert.equal(requests[1].messages.length, 3);
    assert.deepEqual(requests[1].messages[1].annotations, annotation());
    assert.equal(requests[1].messages[1].annotations[0].file.content[1].type, 'image_url');
    assert.equal(requests[1].messages[2].content[0].text, 'A different question in Hindi');
    assert.doesNotMatch(JSON.stringify(requests[1].messages), /First question|Current answer/);
    await router.complete(['Third question', pdf('file two')], 500); assert.equal(requests[2].messages.length, 1);
    scope = 'b'; await router.complete(['Question', pdf('file one')], 500); assert.equal(requests[3].messages.length, 1);
});

test('streaming annotations cache only a complete successful parse and never cache an interrupted answer', async t => {
    const cache = createAttachmentCache(); t.after(() => cache.dispose()); let fail = true; const requests = [];
    const router = createOpenRouter({ chat: { completions: { create: async body => {
        requests.push(body); return (async function* () {
            yield { choices: [{ delta: { annotations: annotation(), content: 'Partial' } }] };
            if (!fail) yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
        })();
    } } } }, { getCacheScope: () => 'a', attachmentCache: cache });
    const source = ['Read this', pdf('one')];
    await assert.rejects(router.complete(source, 500, undefined, () => {}), /Incomplete/);
    fail = false; await router.complete(source, 500, undefined, () => {}); await router.complete(source, 500, undefined, () => {});
    assert.deepEqual(requests.map(body => body.messages.length), [1, 1, 3]);
});

test('invalid/multiple file annotations are not reusable and expired metadata gets one fresh-parse fallback', async t => {
    for (const value of [null, [], [{ type: 'file', file: { hash: 'a', content: [] } }],
        [{ type: 'file', file: { hash: 'a', content: [{ type: 'image_url', image_url: { url: 'https://example.com/expiring-image' } }] } }],
        annotation().concat(annotation()), [{ type: 'file', file: { hash: 'a', content: [{ type: 'unknown' }] } }]])
        assert.equal(reusablePdfAnnotations(value), null);
    const cache = createAttachmentCache(); t.after(() => cache.dispose()); const requests = [];
    const router = createOpenRouter({ chat: { completions: { create: async body => {
        requests.push(body); if (body.messages.length === 3) throw Object.assign(new Error('Stale annotation'), { status: 422 });
        return completion(annotation());
    } } } }, { getCacheScope: () => 'a', attachmentCache: cache });
    await router.complete(['Read', pdf('one')], 500); await router.complete(['Read again', pdf('one')], 500);
    assert.deepEqual(requests.map(body => body.messages.length), [1, 3, 1]);
});

test('multiple PDFs and missing scopes never replay ambiguous parse metadata', async t => {
    const cache = createAttachmentCache(); t.after(() => cache.dispose()); const requests = [];
    const router = createOpenRouter({ chat: { completions: { create: async body => { requests.push(body); return completion(annotation()); } } } },
        { getCacheScope: () => 'a', attachmentCache: cache });
    await router.complete(['Read both', pdf('one'), pdf('two')], 500);
    await router.complete(['Read both again', pdf('one'), pdf('two')], 500);
    assert.deepEqual(requests.map(body => body.messages.length), [1, 1]);
});

test('incremental/conflicting PDF parse fragments never become a partial cached document', async t => {
    const cache = createAttachmentCache(); t.after(() => cache.dispose()); const requests = [];
    const router = createOpenRouter({ chat: { completions: { create: async body => {
        requests.push(body); return (async function* () {
            yield { choices: [{ delta: { annotations: annotation('first fragment'), content: 'Answer' } }] };
            yield { choices: [{ delta: { annotations: annotation('different fragment') }, finish_reason: 'stop' }] };
        })();
    } } } }, { getCacheScope: () => 'account', attachmentCache: cache });
    for (let i = 0; i < 2; i++) await router.complete(['Read', pdf('same')], 500, undefined, () => {});
    assert.deepEqual(requests.map(body => body.messages.length), [1, 1]);
});

test('an in-stream stale parse error retries fresh once before text, but never repeats an emitted preview', async t => {
    const cache = createAttachmentCache(); t.after(() => cache.dispose()); const requests = [], previews = [];
    let emit = false;
    const router = createOpenRouter({ chat: { completions: { create: async body => {
        requests.push(body);
        if (!body.stream) return completion(annotation());
        return (async function* () {
            if (body.messages.length === 3) {
                if (emit) yield { choices: [{ delta: { content: 'Existing preview' } }] };
                yield { error: { code: 422, message: 'Stale parse' } }; return;
            }
            yield { choices: [{ delta: { content: 'Fresh preview', annotations: annotation() }, finish_reason: 'stop' }] };
        })();
    } } } }, { getCacheScope: () => 'account', attachmentCache: cache });
    const source = ['Read', pdf('same')];
    await router.complete(source, 500); await router.complete(source, 500, undefined, text => previews.push(text));
    assert.deepEqual(requests.map(body => body.messages.length), [1, 3, 1]); assert.deepEqual(previews, ['Fresh preview']);
    emit = true; await assert.rejects(router.complete(source, 500, undefined, text => previews.push(text)), /stream failed/);
    assert.equal(requests.length, 4); assert.equal(previews.at(-1), 'Existing preview');
});

test('Smart Notes evicts stale PDF annotations without a second paid attempt', async t => {
    const cache = createAttachmentCache(); t.after(() => cache.dispose()); const requests = [];
    const router = createOpenRouter({ chat: { completions: { create: async body => {
        requests.push(body);
        if (body.messages.length === 3) throw Object.assign(new Error('Stale annotation'), { status: 422 });
        return completion(annotation());
    } } } }, { getCacheScope: () => 'account', attachmentCache: cache, isSmartNote: () => true });
    await router.complete(['First question', pdf('one')], 500);
    await assert.rejects(router.complete(['Second question', pdf('one')], 500), { status: 422 });
    assert.deepEqual(requests.map(body => body.messages.length), [1, 3]);
    await router.complete(['Explicit new request', pdf('one')], 500);
    assert.deepEqual(requests.map(body => body.messages.length), [1, 3, 1]);
});
