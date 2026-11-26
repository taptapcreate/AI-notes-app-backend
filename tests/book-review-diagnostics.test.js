const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reviewResult } = require('../services/writing-review');
const { reviewDiagnostic } = require('../services/book-review-diagnostics');
const { createBookReview } = require('../services/book-review');
const context = {
    task: 'writing-review-improve',
    segments: [{ id: 's0', text: 'Private source line.\nAnother private line.' }, { id: 's1', text: 'A second private passage.' }],
};
const invalid = [
    ['unknown_segment_id', { edits: [{ id: 'private model supplied text', text: 'Private replacement.' }] }],
    ['duplicate_segment_id', { edits: [{ id: 's0', text: context.segments[0].text }, { id: 's0', text: context.segments[0].text }] }],
    ['edit_not_text', { edits: [{ id: 's0', text: null }] }],
    ['empty_edit', { edits: [{ id: 's0', text: '  ' }] }],
    ['edit_too_long', { edits: [{ id: 's0', text: 'private '.repeat(200) }] }],
    ['line_break_mismatch', { edits: [{ id: 's0', text: 'Private source line. Another private line.' }] }],
    ['edits_not_array', { edits: null }],
    ['too_many_edits', { edits: [{}, {}, {}] }],
];
for (const [reason, result] of invalid) test(`review diagnostics distinguish ${reason} without exposing prose`, () => {
    assert.throws(() => reviewResult(JSON.stringify(result), context), error => {
        assert.equal(error.reviewValidation.reason, reason);
        const diagnostic = reviewDiagnostic(error, 'batch', 2, 1);
        assert.equal(diagnostic.reason, reason);
        assert.equal(diagnostic.batchIndex, 2);
        assert.doesNotMatch(JSON.stringify(diagnostic), /private/i);
        return true;
    });
});
test('diagnostics distinguish invalid JSON and strip arbitrary details', () => {
    assert.throws(() => reviewResult('private malformed JSON', context), error => {
        assert.ok(error instanceof SyntaxError);
        assert.equal(reviewDiagnostic(error, 'batch').reason, 'invalid_json');
        return true;
    });
    const diagnostic = reviewDiagnostic({ message: 'private text', segmentIds: ['s0', 'private-id', 's99999'], reviewValidation: {
        reason: 'private secret', sourceChars: 'private text', replacementChars: -1, sourceLineBreaks: 1,
        text: 'private text', title: 'private title',
    } }, 'private stage', 'private index', 'private attempt');
    assert.deepEqual(diagnostic, { stage: 'batch', reason: 'unclassified_validation', segmentIds: ['s0'], sourceLineBreaks: 1 });
});
test('known formatting mismatch keeps its original rejection and numeric measurements', () => {
    assert.throws(() => reviewResult(JSON.stringify({ edits: [{ id: 's0', text: context.segments[0].text.replace('\n', '\r\n') }] }), context), error => {
        assert.equal(error.message, 'The AI review could not be matched safely to your text.');
        assert.deepEqual(reviewDiagnostic(error, 'batch', 0, 1), { stage: 'batch', reason: 'line_break_mismatch', batchIndex: 0, attempt: 1, segmentIds: ['s0'], sourceLineBreaks: 1, replacementLineBreaks: 1 });
        return true;
    });
    assert.deepEqual(reviewResult('{"edits":[]}', context), { edits: [] });
});
test('failed repair is distinguished from batch failures and survives wrapping', async () => {
    const request = { requestId: 'diagnostic-test' }, events = [];
    let calls = 0;
    const run = createBookReview({ getRequest: () => request, onValidation: event => events.push(event), generate: async (_, __, { beforeAttempt }) => {
        await beforeAttempt(); calls++;
        return { text: JSON.stringify({ edits: [{ id: 's0', text: 'Private source line. Another private line.' }] }), finishReason: 'stop' };
    } });
    await assert.rejects(run(context), error => {
        assert.equal(error.code, 'BOOK_REVIEW_INVALID');
        assert.equal(error.reviewValidation.reason, 'line_break_mismatch');
        assert.equal(error.reviewValidation.stage, 'batch');
        assert.equal(error.reviewValidation.attempt, 2);
        assert.equal(error.reviewValidation.batchIndex, 0);
        return true;
    });
    assert.equal(calls, 3);
    assert.deepEqual(events.map(event => event.stage), ['batch', 'batch', 'repair']);
    assert.deepEqual(events.map(event => event.attempt), [1, 2, undefined]);
    assert.equal(request.validationFailureCount, 3);
    assert.equal(request.reviewValidationFailures.length, 3);
    assert.doesNotMatch(JSON.stringify(events), /private/i);
});
test('a diagnostic logger failure never prevents a valid targeted repair', async () => {
    const request = {};
    let calls = 0;
    const run = createBookReview({ getRequest: () => request, onValidation: () => { throw Error('logger unavailable'); }, generate: async (_, __, { beforeAttempt }) => {
        await beforeAttempt(); calls++;
        return { text: JSON.stringify({ edits: calls < 3 ? [{ id: 's0', text: 'Private source line. Another private line.' }] : [] }), finishReason: 'stop' };
    } });
    assert.deepEqual(await run(context), { edits: [] });
    assert.equal(request.recoveredSegments, 1);
    assert.equal(request.validationFailureCount, 2);
});

test('request diagnostics retain a bounded tail while counting every validation failure', async () => {
    const request = {}, events = [];
    const run = createBookReview({ getRequest: () => request, onValidation: event => events.push(event), generate: async (_, __, { beforeAttempt }) => {
        await beforeAttempt();
        return { text: '{"edits":[{"id":"unknown-private-id","text":"private replacement"}]}', finishReason: 'stop' };
    } });
    for (let i = 0; i < 8; i++) await assert.rejects(run(context), { code: 'BOOK_REVIEW_INVALID' });
    assert.equal(events.length, 16);
    assert.equal(request.validationFailureCount, 16);
    assert.equal(request.reviewValidationFailures.length, 12);
    assert.doesNotMatch(JSON.stringify(request.reviewValidationFailures), /private/i);
});
