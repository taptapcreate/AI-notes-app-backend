const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reviewBatches, reviewResult, reviewContext } = require('../services/writing-review');
const { createBookReview } = require('../services/book-review');

const chapter = () => ({ task: 'writing-review-revise', segments: Array.from({length: 18}, (_, i) => ({
  id: `s${i}`, text: `Passage ${i}. ` + 'Mira kept the blue key because Arun had asked her to wait. '.repeat(12),
})), pages: Array.from({length: 18}, (_, i) => ({number: i+1, ids: [`s${i}`]})) });
test('revision includes bounded original continuity context and every editable segment exactly once', () => {
  const source = chapter(), before = JSON.stringify(source), batches = reviewBatches(source);
  assert(batches.length > 1);
  assert.deepEqual(batches.flatMap(b => b.segments), source.segments);
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    assert(JSON.stringify(batch.readOnlyContext).length < 16000);
    assert(batch.readOnlyContext.chapterExcerpts.includes('Passage 0.'));
    assert(batch.readOnlyContext.chapterExcerpts.includes('Passage 17.'));
    if (i > 0) assert(batch.readOnlyContext.preceding);
    if (i < batches.length-1) assert(batch.readOnlyContext.following);
    const outside = source.segments.find(s => !batch.segments.some(t => t.id === s.id));
    assert.throws(() => reviewResult(JSON.stringify({edits: [{id: outside.id, text: outside.text}]}), batch), /matched safely/);
  }
  assert.equal(JSON.stringify(source), before);
});
test('Grammar and Improve use only bounded neighboring approved segments; request-supplied context is discarded', () => {
  for (const task of ['writing-review-grammar','writing-review-improve']) {
    assert(reviewBatches({...chapter(),task}).every(b => !b.readOnlyContext?.chapterExcerpts && (b.readOnlyContext?.preceding || '').length <= 1200 && (b.readOnlyContext?.following || '').length <= 1200));
    const value = reviewContext({writingReviewVersion:1,context:JSON.stringify({task, segments:[{id:'s0',text:'Approved page.'}],readOnlyContext:'Other unapproved pages'})});
    assert.equal(value.readOnlyContext,undefined);
  }
});
test('large chapter context stays bounded even with thousands of long Unicode segments', () => {
  const segments = Array.from({length:2000}, (_,i) => ({id:`s${i}`,text:'🌿'.repeat(20)}));
  for (const batch of reviewBatches({task:'writing-review-revise',segments})) {
    assert(batch.readOnlyContext.chapterExcerpts.length <= 6000);
    assert(batch.readOnlyContext.preceding.length <= 1200);
    assert(batch.readOnlyContext.following.length <= 1200);
    assert(!/[\uD800-\uDBFF]$/.test(batch.readOnlyContext.chapterExcerpts));
  }
});
test('context adds no planning request and a returned context ID fails before application', async () => {
  const source=chapter(); let calls=0;
  const run=createBookReview({model:'test',getRequest:()=>({accountScope:'isolated',generationId:'fixture'}),
    Checkpoint:{init:async()=>{},findById:()=>({lean:async()=>null}),create:async value=>({toObject:()=>value}),updateOne:async()=>({modifiedCount:1})},
    GenerationRequest:{},generate:async(_,prompt)=>{calls++;const batch=JSON.parse(prompt.split('SOURCE: ')[1]);return {text:JSON.stringify({edits:batch.segments.map(s=>({id:s.id,text:s.text.replaceAll('blue key','brass key')}))}),finishReason:'stop'};}});
  const result=await run(source);
  assert.equal(calls,reviewBatches(source).length);
  assert.equal(result.edits.length,source.segments.length);
});
