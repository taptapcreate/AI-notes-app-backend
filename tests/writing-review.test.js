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

const { generationUnits } = require('../services/media-note-billing');
const { reviewBatches } = require('../services/writing-review');
const pageBody = (count = 5) => ({writingReviewVersion:1, writingReviewPolicyVersion:2, bookPageBillingVersion:1, bookPageQuote:count, context:JSON.stringify({task:'writing-review-revise',segments:Array.from({length:count},(_,i)=>({id:'s'+i,text:'Page '+(i+1)+' prose.'})),pages:Array.from({length:count},(_,i)=>({number:i+1,ids:['s'+i]}))})});
test('chapter and selected-page reviews charge exactly one unit per mapped text page', async () => {
 for (const count of [1,3,4,5,30]) assert.equal(await generationUnits('/followup', pageBody(count), {}), count);
 const body = pageBody(); body.bookPageQuote=1; await assert.rejects(generationUnits('/followup',body,{}), /estimate/);
 const noVersion=pageBody();delete noVersion.writingReviewVersion;await assert.rejects(generationUnits('/followup',noVersion,{}), /estimate/);
 const bad=pageBody(); const context=JSON.parse(bad.context);context.pages[1].ids=['s0'];bad.context=JSON.stringify(context);await assert.rejects(generationUnits('/followup',bad,{}), /exactly once/);
 const image=pageBody(1); const imageContext=JSON.parse(image.context);imageContext.segments[0].text='![image](book-image:secret)';image.context=JSON.stringify(imageContext);await assert.rejects(generationUnits('/followup',image,{}), /Images stay/);
 await assert.rejects(generationUnits('/notes',pageBody(),{}), /endpoint/);
});
test('long chapters batch every prose segment exactly once', () => {
 const context=reviewContext(pageBody(30));context.segments.forEach(segment=>segment.text='prose '.repeat(500));
 const batches=reviewBatches(context);assert.ok(batches.length>1);assert.deepEqual(batches.flatMap(batch=>batch.segments),context.segments);
});
