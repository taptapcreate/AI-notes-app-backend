const { test } = require('node:test');
const assert = require('node:assert/strict');
const { noteOutputLimit } = require('../services/note-output-limits');

test('note output limits use defaults for missing or invalid settings and enforce per-length caps', () => {
    const config = { noteOutputTokenLimits: { brief: 650, standard: '2000', detailed: 10, 'in-depth': 10000 } };
    assert.equal(noteOutputLimit(config, 'brief'), 650);
    assert.equal(noteOutputLimit(config, 'standard'), 2500);
    assert.equal(noteOutputLimit(config, 'detailed'), 5000);
    assert.equal(noteOutputLimit(config, 'in-depth'), 8000);
    assert.equal(noteOutputLimit(undefined, 'brief'), 1200);
    assert.equal(noteOutputLimit(config, '__proto__'), 2500);
});
