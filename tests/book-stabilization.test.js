const {test}=require('node:test');const assert=require('node:assert/strict');
const {reviewResult,reviewBatches}=require('../services/writing-review');
const ctx=(texts,pages)=>({task:'writing-review-improve',segments:texts.map((text,i)=>({id:'s'+i,text})),...(pages&&{pages})});
const response=edits=>JSON.stringify({edits});
test('split-sentence leading words cannot disappear while a spelling correction passes',()=>{
 const c=ctx(['Nora disliked running — unless of','course it involved helping somebody. Nora’s favrite place was the library.']);c.task='writing-review-grammar';
 assert.throws(()=>reviewResult(response([{id:'s1',text:'Nora’s favorite place was the library.'}]),c),/boundary|continuation|omitted/);
 assert.equal(reviewResult(response([{id:'s1',text:c.segments[1].text.replace('favrite','favorite')}]),c).edits.length,1);
});
test('an honorific does not make a dangling sentence a complete sentence',()=>{
 const c=ctx(['Owen bent toward Mrs.','Bell, kissed her cheek, and tried to wave to Leo before leaving for work.']);c.task='writing-review-grammar';
 assert.throws(()=>reviewResult(response([{id:'s1',text:'kissed Leo on the cheek and tried to wave to him before leaving for work.'}]),c),/boundary|continuation|omitted/);
});
test('coreference made explicit is not classified as shifted neighboring content',()=>{
 const c=ctx(['Doctor Rowan approached the narrow doorway.','He quietly went in.']);
 assert.equal(reviewResult(response([{id:'s1',text:'Doctor Rowan quietly stepped through the doorway.'}]),c).edits.length,1);
});
test('batch page metadata preserves gaps between explicitly selected pages',()=>{
 const c=ctx(['We walked toward the aged','old bridge beside the river.'],[{number:1,ids:['s0']},{number:3,ids:['s1']}]);
 const b=reviewBatches(c)[0];assert.deepEqual(b.pages,c.pages);
 assert.equal(reviewResult(response([{id:'s0',text:'We walked toward the old'}]),b).edits.length,1);
});
test('an approved selected sentence has bounded context across batches, never unselected pages',()=>{
 const c=ctx(['A quiet sentence. '.repeat(270)+'We reached the','old oak tree. '+'The path was quiet. '.repeat(250)], [{number:1,ids:['s0']},{number:2,ids:['s1']}]);
 const b=reviewBatches(c);assert.equal(b.length,2);assert.equal(b[0].readOnlyContext.following.startsWith('old oak tree.'),true);assert.ok(b[1].readOnlyContext.preceding.endsWith('We reached the'));assert.ok(b[0].readOnlyContext.following.length<=1200);
 const gap=reviewBatches({...c,pages:[{number:1,ids:['s0']},{number:3,ids:['s1']}]});assert.ok(!gap[0].readOnlyContext?.following);
});

test('bounded affected-span repair preserves safe edits and revalidates the complete reconstructed batch',async()=>{
 const {createBookReview}=require('../services/book-review');let calls=0;let repairedIds;const state={};
 const c=ctx(['The first traveler have a clear plan for the journey tomorrow.','The second traveler have a clear plan for the journey tomorrow.','The third traveler have a clear plan for the journey tomorrow.','The report says that Mira and Daniel Vale are missing from the station.']);
 const run=createBookReview({getRequest:()=>state,model:'mock',generate:async(_,prompt,{beforeAttempt})=>{
  await beforeAttempt();calls++;const input=JSON.parse(prompt.split('SOURCE: ')[1]);
  if(calls<=2)return {text:response(input.segments.map((s,i)=>({id:s.id,text:i===3?'Mira missing.':s.text.replace('have','has')}))),finishReason:'stop'};
  repairedIds=input.segments.map(s=>s.id);
  return {text:response(input.segments.map(s=>({id:s.id,text:s.text.replace('says that','states that')}))),finishReason:'stop'};
 }});
 const result=await run(c);assert.equal(calls,3);assert.deepEqual(repairedIds,['s3']);assert.equal(result.edits.length,4);assert.equal(state.recoveredSegments,1);
 const reconstructed=c.segments.map(s=>result.edits.find(e=>e.id===s.id)?.text||s.text).join(' ');
 assert.match(reconstructed,/Mira and Daniel Vale are missing from the station/);
});

test('wrapped split-line manuscripts allow synonym rewrites, coordinated reflow, all-caps headings, and multi-line rebalancing without relaxing real omission/shift checks', async () => {
 const story = ctx([
  'When the family woke on the gray morning our story',
  'starts, nothing in the quiet street suggested trouble.',
 ]);
 assert.equal(
  reviewResult(response([{ id: 's1', text: 'begins, nothing in the quiet street hinted at trouble.' }]), story).edits.length,
  1,
 );
 assert.throws(
  () => reviewResult(response([{ id: 's1', text: 'Trouble arrived before breakfast ended.' }]), story),
  /split continuation/,
 );

 const heading = ctx(['CHAPTER TWO', 'THE VANISHING HALL', 'early ten years had passed since the letter arrived on the doorstep.']);
 heading.task = 'writing-review-grammar';
 assert.equal(
  reviewResult(response([{ id: 's2', text: 'Nearly ten years had passed since the letter arrived on the doorstep.' }]), heading).edits.length,
  1,
 );

 const wrapped = ctx([
  'She was proud to insist that her quiet street held',
  'no odd neighbors, no strange birds, and very little foolish',
  'rumor worth repeating before morning tea.',
 ]);
 wrapped.task = 'writing-review-revise';
 const balanced = reviewResult(response([
  { id: 's0', text: 'She proudly insisted that her quiet' },
  { id: 's1', text: 'street held no odd neighbors, strange birds, or' },
  { id: 's2', text: 'foolish rumors before morning tea.' },
 ]), wrapped);
 assert.equal(balanced.edits.length, 3);
 wrapped.task = 'writing-review-grammar';
 const condensed = reviewResult(response([
  { id: 's0', text: 'She insisted that her street held' },
  { id: 's1', text: 'no odd neighbors, strange birds, or foolish' },
  { id: 's2', text: 'rumors before tea.' },
 ]), wrapped);
 assert.equal(condensed.edits.length, 3);
 assert.throws(
  () => reviewResult(response([
   { id: 's0', text: 'She insisted.' },
   { id: 's1', text: 'rumors.' },
  ]), wrapped),
  /omitted too much/,
 );

 const { createBookReview } = require('../services/book-review');
 const multi = ctx([
  'The first traveler held a bright brass lantern beside the tall iron gate of',
  'silver iron along the wet cobblestone lane.',
  'The second traveler waited quietly by the pier.',
  'The third report states that Clara and Martin Vale are missing from the harbor.',
 ], [{ number: 1, ids: ['s0', 's1', 's2', 's3'] }]);
 multi.task = 'writing-review-revise';
 let calls = 0;
 const repairCalls = [];
 const run = createBookReview({
  getRequest: () => ({}),
  model: 'mock',
  generate: async (_cap, prompt, { beforeAttempt }) => {
   await beforeAttempt();
   calls++;
   const input = JSON.parse(prompt.split('SOURCE: ')[1]);
   const ids = input.segments.map(s => s.id);
   if (calls <= 2) {
    return {
     text: response([
      { id: 's0', text: 'The traveler.' },
      { id: 's1', text: 'silver iron down the wet cobblestone lane.' },
      { id: 's3', text: 'Clara missing.' },
     ]),
     finishReason: 'stop',
    };
   }
   repairCalls.push(ids);
   if (ids.includes('s0')) {
    return {
     text: response([
      { id: 's0', text: 'The first traveler carried a bright lantern by' },
      { id: 's1', text: 'the wrought-iron gate beside the wet cobblestones.' },
     ]),
     finishReason: 'stop',
    };
   }
   return {
    text: response([
     { id: 's3', text: 'The third report notes that Clara and Martin Vale are missing from the harbor.' },
    ]),
    finishReason: 'stop',
   };
  },
 });
 const recovered = await run(multi);
 assert.equal(recovered.edits.length, 3);
 assert.deepEqual(repairCalls, [['s0', 's1'], ['s3']]);
});

test('parseReviewJson recovers minor JSON syntax defects while still rejecting truncated output', () => {
 const { parseReviewJson } = require('../services/writing-review');
 const defectJson = '{\n  "edits": [\n    {"id": "s0", "text": "Don\\\'t forget —\\tthe train\nleaves soon.",},\n  ],\n}';
 assert.deepEqual(parseReviewJson(defectJson), {
  edits: [{ id: 's0', text: "Don't forget —\tthe train\nleaves soon." }],
 });
 const dialogueJson = 'Here is {meta} and an odd "quote before JSON:\n{"edits":[{"id":"s0","text":""Little tyke," chortled Mr. Dursley, "no\\-one knows.""}]}';
 assert.deepEqual(parseReviewJson(dialogueJson), {
  edits: [{ id: 's0', text: '"Little tyke," chortled Mr. Dursley, "no-one knows."' }],
 });
 assert.deepEqual(parseReviewJson('[{"id":"s0","text":"Array wrapped output."}]'), {
  edits: [{ id: 's0', text: 'Array wrapped output.' }],
 });
 assert.throws(() => parseReviewJson('{"edits":[{"id":"s0","text":"Still truncated'), SyntaxError);
});

test('single-batch multi-segment review recovers from repeated JSON syntax or length failures by splitting', async () => {
 const { createBookReview } = require('../services/book-review');
 const batchCalls = [];
 const state = {};
 const story = ctx([
  'The first sentence in this paragraph has an error.',
  'The second sentence in this paragraph also have an error.',
  'The third sentence in this paragraph keeps steady pacing.',
  'The fourth sentence in this paragraph closes the scene.',
 ]);
 const run = createBookReview({
  getRequest: () => state,
  model: 'mock',
  generate: async (_cap, prompt, { beforeAttempt }) => {
   await beforeAttempt();
   const input = JSON.parse(prompt.split('SOURCE: ')[1]);
   const ids = input.segments.map((s) => s.id);
   batchCalls.push(ids);
   if (ids.length === 4) {
    return batchCalls.length === 1
     ? { text: '{"edits":[{"id":"s0","text":"broken', finishReason: 'stop' }
     : { text: '{"edits":[{"id":"s0","text":"truncated', finishReason: 'length' };
   }
   return {
    text: response(ids.map((id) => ({ id, text: input.segments.find((s) => s.id === id).text.replace('have', 'has') }))),
    finishReason: 'stop',
   };
  },
 });
 const result = await run(story);
 assert.equal(batchCalls.length, 4);
 assert.equal(batchCalls[2].length, 2);
 assert.equal(batchCalls[3].length, 2);
 assert.equal(result.edits.length, 4);
 assert.equal(state.recoveredSegments, 4);
});
