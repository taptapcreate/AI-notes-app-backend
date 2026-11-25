const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { validateInput } = require('../services/generation');
const { generationUnits } = require('../services/media-note-billing');
const {
    validateNotePrompt,
    sourceBytes,
    promptBytes,
} = require('../services/smart-note-safety');
const {
    prepareNoteImages,
    audioDuration,
} = require('../services/media-preflight');
const { createSingleAttempt } = require('../services/single-attempt');

function wav(seconds, rate = 8000) {
    const data = Buffer.alloc(44 + seconds * rate);
    data.write('RIFF');
    data.writeUInt32LE(data.length - 8, 4);
    data.write('WAVEfmt ', 8);
    data.writeUInt32LE(16, 16);
    data.writeUInt16LE(1, 20);
    data.writeUInt16LE(1, 22);
    data.writeUInt32LE(rate, 24);
    data.writeUInt32LE(rate, 28);
    data.writeUInt16LE(1, 32);
    data.writeUInt16LE(8, 34);
    data.write('data', 36);
    data.writeUInt32LE(data.length - 44, 40);
    return data.toString('base64');
}
test('source preflight measures serialized Unicode bytes and rejects oversized text without truncation', () => {
    const source = {
        type: 'text',
        content: 'Useful writing 🌍',
        noteLength: 'brief',
    };
    validateInput('/notes', source);
    assert.equal(source.content, 'Useful writing 🌍');
    for (const content of [
        'x'.repeat(sourceBytes),
        '語'.repeat(sourceBytes / 3),
        '\\'.repeat(sourceBytes / 2),
    ])
        assert.throws(() => validateInput('/notes', { ...source, content }), {
            status: 413,
        });
    assert.throws(
        () =>
            validateInput('/notes', {
                ...source,
                instruction: 'x'.repeat(4001),
            }),
        { status: 413 },
    );
    assert.throws(
        () =>
            validateInput('/followup', {
                context: 'x'.repeat(20000),
                question: 'x'.repeat(5000),
            }),
        { status: 413 },
    );
    assert.throws(() => validateNotePrompt('x'.repeat(promptBytes + 1)), {
        status: 413,
    });
});
test('Smart Notes calls the provider once on busy/error/empty results; cancellation and oversized prompts make zero calls', async () => {
    for (const status of [429, 503, 500, 401]) {
        let calls = 0;
        const run = createSingleAttempt({
            complete: async () => {
                calls++;
                throw Object.assign(Error('provider error'), { status });
            },
        });
        await assert.rejects(run(2500, 'A source'), { status });
        assert.equal(calls, 1);
        await assert.rejects(run(2500, 'x'.repeat(promptBytes + 1)), {
            status: 413,
        });
        assert.equal(calls, 1);
    }
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await assert.rejects(
        createSingleAttempt({
            complete: async () => {
                calls++;
            },
            getSignal: () => controller.signal,
        })(2500, 'A source'),
    );
    assert.equal(calls, 0);
});
test('valid images are decoded locally, resized consistently and retain the original uploaded source', async () => {
    const png = await sharp({
        create: {
            width: 3000,
            height: 1000,
            channels: 4,
            background: '#ff000080',
        },
    })
        .png()
        .toBuffer();
    const body = { type: 'image', content: png.toString('base64') };
    const prepared = await prepareNoteImages(body);
    const metadata = await sharp(
        Buffer.from(prepared.content, 'base64'),
    ).metadata();
    assert.equal(metadata.width, 2048);
    assert.equal(metadata.format, 'jpeg');
    assert.equal(body.content, png.toString('base64'));
    const mixed = await prepareNoteImages({
        ...body,
        additionalImages: [body.content],
    });
    assert.equal(mixed.additionalImages.length, 1);
    await assert.rejects(
        prepareNoteImages({
            type: 'image',
            content: Buffer.from('corrupt png').toString('base64'),
        }),
        { status: 400 },
    );
    await assert.rejects(
        prepareNoteImages({
            type: 'image',
            content: Buffer.from('<svg/>').toString('base64'),
        }),
        { status: 400 },
    );
});
test('audio duration is read from bytes, including non-desktop containers, before billing', async () => {
    assert.equal(await audioDuration(wav(1), 180), 1);
    await assert.rejects(audioDuration(wav(181), 180), { status: 400 });
    await assert.rejects(
        audioDuration(Buffer.from('ID3fake duration=1').toString('base64')),
        { status: 400 },
    );
    assert.equal(
        await generationUnits('/notes', {
            type: 'voice',
            content: wav(180),
            mobileMediaBilling: 1,
            mediaCreditQuote: 2,
        }),
        2,
    );
    await assert.rejects(
        generationUnits('/notes', {
            type: 'voice',
            content: wav(181),
            mobileMediaBilling: 1,
            mediaCreditQuote: 2,
        }),
        { status: 400 },
    );
    await assert.rejects(
        generationUnits('/notes', {
            type: 'image',
            sourceKind: 'walkthrough',
            content: 'AAAA',
            narration: wav(1),
        }),
        { status: 400 },
    );
});

test('Smart Notes provider routing has a price ceiling and no hidden provider fallback', async () => {
    const { createOpenRouter } = require('../services/openrouter');
    const requests = [];
    const router = createOpenRouter(
        {
            chat: {
                completions: {
                    create: async (body) => {
                        requests.push(body);
                        return {
                            choices: [
                                {
                                    message: { content: 'A note' },
                                    finish_reason: 'stop',
                                },
                            ],
                        };
                    },
                },
            },
        },
        { isSmartNote: () => true },
    );
    await router.complete('Source', 2500);
    assert.deepEqual(requests[0].provider, {
        max_price: { prompt: 0.1, completion: 0.5 },
        allow_fallbacks: false,
    });
});
test('dense digital PDF text and oversized physical pages fail locally before OCR', async () => {
    const { PDFDocument, StandardFonts } = require('pdf-lib');
    const { validatePdfSource } = require('../services/media-preflight');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let pageNumber = 0; pageNumber < 2; pageNumber++) {
        const page = doc.addPage();
        for (let line = 0; line < 180; line++)
            page.drawText('Dense source text '.repeat(6), {
                x: 10,
                y: 800 - line * 4,
                size: 2,
                font,
            });
    }
    await assert.rejects(validatePdfSource(await doc.saveAsBase64()), {
        status: 413,
    });
    const poster = await PDFDocument.create();
    poster.addPage([2000, 2000]);
    await assert.rejects(validatePdfSource(await poster.saveAsBase64()), {
        status: 400,
    });
    const simple = await PDFDocument.create();
    simple.addPage().drawText('Ordinary PDF text');
    await validatePdfSource(await simple.saveAsBase64());
});
