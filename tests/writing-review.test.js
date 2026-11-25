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
test('reviews have a dedicated JSON prompt and preserve expressive prose without manufacturing edits', () => {
 const context = reviewContext(body);
 assert.deepEqual(reviewResult('{"edits":[]}', context), { edits: [] });
 assert.match(reviewPrompt(context), /smallest useful change/);
 assert.match(reviewPrompt(context), /light, targeted polish/);
 assert.match(reviewPrompt(context), /invent errors/);
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
test('improve writing uses stylistic editing instructions distinct from fix grammar across selection, single-page, and multi-page scopes', () => {
 const p1 = 'Julian was standing near the window. He was angry about the situation, and he was also frustrated because he could not leave the hotel. The weather outside was very bad. The wind was strong, and the snow was falling heavily.';
 const p2 = 'Damian was sitting on the sofa. He looked at Julian and smiled because he knew that Julian was annoyed. Damian enjoyed annoying Julian, and he knew exactly what to say to make Julian even more annoyed. The room was quiet, but there was a lot of tension between the two men.';
 for (const pages of [[{number:1,ids:['s0','s1']}],[{number:1,ids:['s0']},{number:2,ids:['s1']}]]) {
  const ctx = reviewContext({writingReviewVersion:1,writingReviewPolicyVersion:2,bookPageBillingVersion:1,bookPageQuote:pages.length,context:JSON.stringify({task:'writing-review-improve',pages,segments:[{id:'s0',text:p1},{id:'s1',text:p2}]})});
  const prompt = reviewPrompt(reviewBatches(ctx)[0]);
  assert.match(prompt, /line and stylistic editor/);
  assert.match(prompt, /even when grammar is already correct/);
  assert.doesNotMatch(prompt, /First proofread every editable segment/);
  assert.doesNotMatch(prompt, /When proofreading, preserve deliberate punctuation/);
  const improved = {
   edits: [
    { id: 's0', text: 'Julian stood beside the frosted window, seething with anger and frustration at being trapped inside the hotel. Outside, a fierce gale howled down the street, driving heavy snow against the cold glass.' },
    { id: 's1', text: 'Settled on the sofa, Damian watched him with a knowing smile, clearly reading Julian\'s irritation. He relished provoking his companion and knew precisely which quiet remark would push him past his breaking point, thickening the silence between them with unspoken tension.' },
   ],
  };
  assert.equal(reviewResult(JSON.stringify(improved), ctx).edits.length, 2);
  assert.throws(() => reviewResult(JSON.stringify({edits:[{id:'s0',text:'Julian was mad.'}]}), ctx), /omitted too much/);
 }
});
test('grammar reviews parse wrapped or fenced JSON across 30-page chapters while rejecting truncated JSON', () => {
 const segments = Array.from({ length: 30 }, (_, i) => ({
  id: `s${i}`,
  text: i % 5 === 0
   ? `Page ${i + 1} have a clear grammar error in this sentence.`
   : `Page ${i + 1} is already grammatically sound and reads cleanly.`,
 }));
 const pages = segments.map((s, i) => ({ number: i + 1, ids: [s.id] }));
 const ctx = reviewContext({
  writingReviewVersion: 1,
  writingReviewPolicyVersion: 2,
  bookPageBillingVersion: 1,
  bookPageQuote: 30,
  context: JSON.stringify({ task: 'writing-review-grammar', pages, segments }),
 });
 assert.deepEqual(reviewResult('No errors found.\n```json\n{"edits":[]}\n```', ctx), { edits: [] });
 assert.deepEqual(
  reviewResult('Here is your review:\n{"edits":[{"id":"s0","text":"Page 1 has a clear grammar error in this sentence."}]}\nDone.', ctx),
  { edits: [{ id: 's0', text: 'Page 1 has a clear grammar error in this sentence.' }] },
 );
 assert.throws(() => reviewResult('{"edits":[{"id":"s0","text":"Truncated', ctx), SyntaxError);
});
test('revise chapter prompt requires evaluating every segment and repairing fused or corrupted words', () => {
 const ctx = reviewContext(pageBody(3));
 const prompt = reviewPrompt(reviewBatches(ctx)[0]);
 assert.match(prompt, /Evaluate every segment in SOURCE\.segments thoroughly/);
 assert.match(prompt, /fused or split words/);
 assert.match(prompt, /accidental word or character corruption/);
});
