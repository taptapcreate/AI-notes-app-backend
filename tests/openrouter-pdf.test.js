const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pdfPart, InvalidPdf } = require('../services/openrouter-pdf');

const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const modelSource = server.slice(server.indexOf('const getModel ='), server.indexOf('// Get the model for streaming'));

test('PDF Smart Notes sends the actual file through OpenRouter to the default GPT model', async () => {
    const requests = [];
    const signal = new AbortController().signal;
    const model = vm.runInNewContext(`${modelSource}\ngetModel(900)`, {
        pdfPart,
        generationSignal: () => signal,
        openai: { chat: { completions: { create: async (body, options) => {
            requests.push({ body, options });
            return { choices: [{ message: { content: 'Summary' } }] };
        } } } },
        genAI: { getGenerativeModel: () => assert.fail('PDF must use OpenRouter') },
    });
    const base64 = Buffer.from('%PDF-1.7\n').toString('base64');
    const result = await model.generateContent(['Summarize this document.', { inlineData: {
        mimeType: 'application/pdf', data: base64,
    } }]);
    const [{ body, options }] = requests;
    assert.equal(body.model, 'openai/gpt-4o-mini');
    assert.equal(body.max_tokens, 900);
    assert.equal(body.plugins[0].id, 'file-parser');
    assert.equal(body.plugins[0].pdf.engine, 'mistral-ocr');
    assert.equal(body.messages[0].content[1].file.file_data, `data:application/pdf;base64,${base64}`);
    assert.equal(options.signal, signal);
    assert.equal(result.response.text(), 'Summary');
    const pdfRoute = server.slice(server.indexOf("case 'pdf':"), server.indexOf("case 'website':"));
    assert.match(pdfRoute, /const pdfModel = getModel\(maxTokens\);/);
});

test('PDF validation rejects missing, malformed, and non-PDF uploads', () => {
    for (const input of [null, '', '###=', Buffer.from('not a pdf').toString('base64')]) {
        assert.throws(() => pdfPart(input), InvalidPdf);
    }
});
