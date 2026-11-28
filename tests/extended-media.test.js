const test = require('node:test');
const assert = require('node:assert/strict');
const { generationUnits, generationMediaPricing } = require('../services/media-note-billing');
const { validateInput } = require('../services/generation');
const { validateImageBatch, noteImageParts } = require('../services/image-attachments');
const { createOpenRouter } = require('../services/openrouter');

function jpeg(width = 100, height = 100) {
    const value = Buffer.from('ffd8ffc00011080064006403011100021100031100ffd9', 'hex');
    value.writeUInt16BE(height, 7); value.writeUInt16BE(width, 9);
    return value.toString('base64');
}
function pcm(seconds) {
    const data = Buffer.alloc(44 + Math.round(seconds * 32000));
    data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
    data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
    data.writeUInt32LE(16000, 24); data.writeUInt32LE(32000, 28);
    data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36);
    data.writeUInt32LE(data.length - 44, 40);
    return data.toString('base64');
}
const batch = (count, quote = 1 + Math.floor(count / 2)) => ({
    type: 'image', sourceKind: 'image', content: jpeg(),
    additionalImages: Array.from({ length: count - 1 }, () => jpeg()),
    desktopMediaBilling: 1, mediaCreditQuote: quote,
});

test('image batches verify the actual count, reject stale quotes and require authenticated modern billing', async () => {
    for (const count of [2, 3, 4, 5]) {
        const body = batch(count);
        validateInput('/notes', body);
        assert.equal(await generationUnits('/notes', body), 1 + Math.floor(count / 2));
        await assert.rejects(generationUnits('/notes', { ...body, mediaCreditQuote: 1 }), { status: 409 });
        await assert.rejects(generationUnits('/notes', { ...body, desktopMediaBilling: undefined }), { status: 426 });
        await assert.rejects(generationUnits('/notes', { ...body, mediaCreditQuote: undefined }), { status: 426 });
    }
    assert.equal(await generationUnits('/notes', { type: 'image', content: jpeg() }), 1);
    for (const body of [batch(6), { ...batch(2), sourceKind: 'video' },
        { ...batch(2), additionalImages: ['bad'] }, { ...batch(2), content: jpeg(2049) },
        { ...batch(2), additionalImages: [] }, { ...batch(2), type: 'text' }])
        assert.throws(() => validateImageBatch(body), { status: 400 });
    assert.throws(() => validateInput('/reply', { ...batch(2), message: 'Hello' }), { status: 400 });
    assert.doesNotThrow(() => validateImageBatch({ ...batch(2), content: jpeg(2048, 1024) }));
    const huge = Buffer.concat([Buffer.from(jpeg(), 'base64'), Buffer.alloc(8 * 1024 * 1024)]).toString('base64');
    assert.throws(() => validateImageBatch({ ...batch(2), content: huge, additionalImages: [huge] }), { status: 413 });
});

test('desktop audio uses actual duration, enforces five minutes and preserves short-audio pricing', async () => {
    for (const [seconds, cost] of [[180, 2], [180.001, 3], [300, 3]]) {
        const body = { type: 'voice', content: pcm(seconds), desktopMediaBilling: 1, mediaCreditQuote: cost };
        assert.equal(await generationUnits('/notes', body), cost);
        await assert.rejects(generationUnits('/notes', { ...body, mediaCreditQuote: cost + 1 }), { status: 409 });
        if (seconds > 180) {
            await assert.rejects(generationUnits('/notes', { ...body, mediaCreditQuote: undefined }), { status: 426 });
            await assert.rejects(generationUnits('/notes', { ...body, desktopMediaBilling: undefined }), { status: 400 });
        }
    }
    await assert.rejects(generationUnits('/notes', {
        type: 'voice', content: pcm(300.001), desktopMediaBilling: 1, mediaCreditQuote: 3,
    }), { status: 400 });
    assert.deepEqual(generationMediaPricing(), { audioExtra: 1, audioLongExtra: 2, narrationExtra: 1, pdfPagesPerCredit: 3 });
    assert.equal(generationMediaPricing({ generationMediaPricing: { audioExtra: 2 } }).audioLongExtra, 3);
    assert.throws(() => generationMediaPricing({ generationMediaPricing: { audioExtra: 2, audioLongExtra: 2 } }), { status: 503 });
    // Real mobile recordings keep their price; synthetic/corrupt headers fail before AI.
    assert.equal(await generationUnits('/notes', { type: 'voice', content: pcm(1), mobileMediaBilling: 1 }), 2);
    await assert.rejects(generationUnits('/notes', { type: 'voice', content: Buffer.from('ID3audio').toString('base64'), mobileMediaBilling: 1 }), { status: 400 });
    await assert.rejects(generationUnits('/notes', { type: 'voice', content: Buffer.from('RIFF0000WAVElegacy-stereo').toString('base64') }), { status: 400 });
});

test('all five selected images reach the provider in one ordered request', async () => {
    const body = batch(5); const requests = [];
    body.additionalImages = [101, 102, 103, 104].map(width => jpeg(width));
    const router = createOpenRouter({ chat: { completions: { create: async request => {
        requests.push(request); return { choices: [{ message: { content: 'Combined note' }, finish_reason: 'stop' }] };
    } } } });
    await router.complete(['Read all selected images together.', ...noteImageParts(body)], 1000);
    assert.equal(requests.length, 1);
    const content = requests[0].messages[0].content;
    assert.equal(content.length, 6);
    assert.deepEqual(content.slice(1).map(part => part.image_url.url.split(',')[1]), [body.content, ...body.additionalImages]);
});


test('mobile image batches use the same count pricing without allowing ambiguous billing flags', async () => {
    for (const count of [2, 3, 4, 5]) {
        const body = { ...batch(count), desktopMediaBilling: undefined, mobileMediaBilling: 1, appFeature: 'image' };
        validateInput('/notes', body);
        assert.equal(await generationUnits('/notes', body), 1 + Math.floor(count / 2));
        await assert.rejects(generationUnits('/notes', { ...body, mediaCreditQuote: 1 }), { status: 409 });
        for (const invalid of [
            { ...body, mediaCreditQuote: undefined }, { ...body, mobileMediaBilling: 2 },
            { ...body, desktopMediaBilling: 1 }, { ...body, mobileMediaBilling: undefined },
        ]) await assert.rejects(generationUnits('/notes', invalid), { status: 426 });
    }
    assert.throws(() => validateImageBatch({ ...batch(5), sourceKind: undefined }), /incompatible/);
});
