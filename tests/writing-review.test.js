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

const { reviewContext, reviewResult, reviewPrompt } = require('../services/writing-review');
const body = { writingReviewVersion: 1, context: JSON.stringify({ task: 'writing-review-grammar', segments: [{ id: 's0', text: 'This is correct.' }] }) };
test('reviews have a dedicated JSON prompt and request useful polish without manufacturing edits', () => {
 const context = reviewContext(body);
 assert.deepEqual(reviewResult('{"edits":[]}', context), { edits: [] });
 assert.match(reviewPrompt(context), /If grammar is already correct/);
 assert.match(reviewPrompt(context), /Do not invent errors/);
 assert.match(reviewPrompt(context), /Return ONLY valid JSON/);
 assert.doesNotMatch(reviewPrompt(context), /Follow-up Answer/);
 for (const result of ['oops', '{"edits":null}', '{"edits":[{"id":"bad","text":"Changed"}]}', '{"edits":[{"id":"s0","text":""}]}'])
  assert.throws(() => reviewResult(result, context));
 assert.equal(reviewContext({ context: 'Ordinary follow-up' }), null);
 assert.throws(() => reviewContext({ ...body, writingReviewVersion: 2 }));
 assert.throws(() => reviewContext({ ...body, writingReviewPolicyVersion: 3 }));
 assert.ok(reviewContext({ ...body, writingReviewPolicyVersion: 2 }));
});
