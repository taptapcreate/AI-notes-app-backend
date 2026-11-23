const { test } = require('node:test');
const assert = require('node:assert/strict');
const { processingDisclosure } = require('../services/processing-disclosure');
const AppConfig = require('../models/AppConfig');

test('existing installations receive a short disclosure including the cloud PDF provider', () => {
    const value = processingDisclosure();
    assert.deepEqual(value.providers, ['OpenRouter', 'OpenAI']);
    assert.deepEqual(value.cloudPdfProviders, ['Mistral']);
    assert.match(value.recoveryMessage, /up to 24 hours/);
});

test('MongoDB configuration persists custom providers and copy without changing routing', () => {
    const config = new AppConfig({ processingDisclosure: {
        providers: ['Example gateway', 'Example AI'], cloudPdfProviders: ['Example OCR'],
        recoveryMessage: 'Results are recoverable for up to 24 hours.',
        details: 'Hosted on our infrastructure provider.',
    } });
    assert.equal(config.validateSync(), undefined);
    assert.deepEqual(processingDisclosure(config), config.toObject().processingDisclosure);
});

test('invalid or oversized direct database edits fall back instead of expanding the card', () => {
    const fallback = processingDisclosure();
    assert.deepEqual(processingDisclosure({ processingDisclosure: {
        providers: [], cloudPdfProviders: ['X'.repeat(41)],
        recoveryMessage: 'X'.repeat(141), details: 'X'.repeat(181),
    } }), fallback);
    assert.deepEqual(processingDisclosure({ processingDisclosure: {
        providers: [' OpenAI ', 'OpenAI'],
    } }).providers, ['OpenAI']);
});
