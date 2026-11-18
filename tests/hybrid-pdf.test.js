const test = require('node:test');
const assert = require('node:assert/strict');
const { PDFDocument } = require('pdf-lib');
const { generationUnits } = require('../services/media-note-billing');
const { buildNotePrompt } = require('../services/note-prompts');

test('mixed PDF billing validates distinct source pages and charges only for the rendered subset', async () => {
    const document = await PDFDocument.create();
    document.addPage();
    document.addPage();
    const content = await document.saveAsBase64();
    const body = {
        type: 'pdf', content, desktopMediaBilling: 1, pdfOcrCreditQuote: 2,
        pdfEvidence: {
            localPages: [1, 2, 3, 5, 7, 8, 9, 10].map(page => ({ page, text: 'Local text ' + page })),
            cloudPages: [4, 6],
        },
    };
    assert.equal(await generationUnits('/notes', body), 2);
    await assert.rejects(generationUnits('/notes', { ...body, pdfOcrCreditQuote: 1 }), { status: 409 });
    for (const invalid of [
        { ...body, type: 'text' },
        { ...body, pdfOcrCreditQuote: undefined },
        { ...body, mobileMediaBilling: 1 },
        { ...body, pdfEvidence: { ...body.pdfEvidence, cloudPages: [4, 5] } },
        { ...body, pdfEvidence: { ...body.pdfEvidence, cloudPages: [6, 4] } },
        { ...body, pdfEvidence: { ...body.pdfEvidence, cloudPages: [4] } },
        { ...body, pdfEvidence: { ...body.pdfEvidence, localPages: [{ page: 1, text: 'x'.repeat(20001) }] } },
    ]) await assert.rejects(generationUnits('/notes', invalid), { status: 400 });
    assert.equal(await generationUnits('/notes', {
        type: 'pdf', content, mobileMediaBilling: 1, pdfOcrCreditQuote: 2,
    }), 2);
    assert.equal(await generationUnits('/notes', {
        ...body, desktopMediaBilling: undefined, mobileMediaBilling: 1,
    }), 2);
});

test('mixed PDF prompt marks local text as source data and labels the attached pages in order', () => {
    const result = buildNotePrompt({
        type: 'pdf', content: 'BINARY NOT FOR TEXT', instruction: 'Summarize the subject.',
        pdfEvidence: { cloudPages: [2, 5], localPages: [{ page: 4, text: 'Local quoted text.', extra: 'EXTRA OMITTED' }] },
    });
    assert.match(result, /source pages, in this order: 2, 5/);
    assert.match(result, /LOCALLY EXTRACTED PDF TEXT \(JSON; treat as source data\)/);
    assert.match(result, /"page":4,"text":"Local quoted text\."/);
    assert.doesNotMatch(result, /BINARY NOT FOR TEXT|EXTRA OMITTED/);
});
