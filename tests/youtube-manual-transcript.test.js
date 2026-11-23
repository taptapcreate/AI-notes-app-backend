const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createManualTranscript } = require('../services/youtube-manual-transcript');
const page = '"captionTracks":[{"languageCode":"fr","baseUrl":"https://www.youtube.com/fr"},{"languageCode":"en","baseUrl":"https://www.youtube.com/en"}]';

test('both fallback requests have timeouts, a shared cancellation budget and bounded response sizes', async () => {
    const calls = [];
    const read = createManualTranscript({ http: { get: async (url, options) => {
        calls.push({ url, options });
        return { data: calls.length === 1 ? page : '<transcript><text>First &amp; second</text><text>Next line</text></transcript>' };
    } } });
    assert.equal(await read('example-id'), 'First & second Next line');
    assert.match(calls[1].url, /\/en$/);
    for (const { options } of calls) {
        assert.equal(options.timeout, 10000);
        assert.equal(options.maxContentLength, 4 * 1024 * 1024);
    }
    assert.equal(calls[0].options.signal, calls[1].options.signal);
});

test('cancelled generations stop before the next fetch and retain the cancellation reason', async () => {
    let calls = 0;
    const controller = new AbortController(), reason = new Error('Cancelled');
    const read = createManualTranscript({ http: { get: async () => {
        calls++; controller.abort(reason); return { data: page };
    } } });
    await assert.rejects(read('id', { signal: controller.signal }), error => error === reason);
    assert.equal(calls, 1);
});

test('a hung fallback is aborted at its overall deadline', async () => {
    let aborted = false;
    const keepAlive = setTimeout(() => {}, 1000);
    try {
        const read = createManualTranscript({ timeoutMs: 20, http: { get: (_url, { signal }) =>
            new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
                aborted = true; reject(signal.reason);
            }, { once: true })) } });
        assert.equal(await read('id'), null);
        assert.equal(aborted, true);
    } finally { clearTimeout(keepAlive); }
});
