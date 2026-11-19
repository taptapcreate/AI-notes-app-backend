const { test } = require('node:test');
const assert = require('node:assert/strict');
const { writingReviewPrompt } = require('../services/writing-review');
test('writing reviews request only changed JSON segments, while ordinary follow-ups keep their existing route', () => {
    assert.equal(writingReviewPrompt('ordinary context', 'Why?'), null);
    assert.equal(writingReviewPrompt('{"task":"other"}', 'Why?'), null);
    const context = JSON.stringify({ task: 'writing-review-grammar', segments: [{ id: 's0', text: 'She go home.' }] });
    const prompt = writingReviewPrompt(context, 'Fix grammar only.');
    assert.match(prompt, /Return ONLY valid JSON/); assert.match(prompt, /Include only changed segments/);
    assert.ok(prompt.endsWith(context)); assert.ok(!prompt.includes('## Follow-up Answer'));
    assert.throws(() => writingReviewPrompt('{"task":"writing-review-improve","segments":[]}', 'Improve'), /Invalid/);
});
