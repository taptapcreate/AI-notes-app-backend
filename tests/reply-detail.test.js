const test=require('node:test');const assert=require('node:assert/strict');
const {replyDetail}=require('../services/reply-detail');
test('mobile reply length choices affect guidance and allow enough output for five complete detailed options',()=>{
 const brief=replyDetail('Brief'),detailed=replyDetail('Detailed');
 assert.match(brief.instruction,/35–65/);assert.match(detailed.instruction,/120–180/);assert.ok(detailed.maxTokens>brief.maxTokens);
 assert.deepEqual(replyDetail('unknown'),replyDetail('Standard'));
});
test('detailed analysis asks for supported evidence and practical implications without invented intentions',()=>{
 const detail=replyDetail('Detailed',true);
 assert.match(detail.instruction,/evidence/);assert.match(detail.instruction,/practical implication/);assert.match(detail.instruction,/Do not.*invent/);assert.ok(detail.maxTokens>=3072);
 assert.notEqual(detail.instruction,replyDetail('Brief',true).instruction);
});
