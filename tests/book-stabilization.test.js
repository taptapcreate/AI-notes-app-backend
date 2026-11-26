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
