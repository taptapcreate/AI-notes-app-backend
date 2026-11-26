const {test}=require('node:test');const assert=require('node:assert/strict');
const {checkFailureCooldown}=require('../services/generation-safety');
const now=new Date('2026-11-26T00:00:00Z');
function requests(results){let index=0;return {find(){const result=results[index++] || [];return {sort(){return this;},limit(){return this;},async lean(){return result;}};}};}
test('request and operation pauses expose their actual remaining duration without changing thresholds',async()=>{
 const failures=Array.from({length:3},()=>({createdAt:new Date(now.getTime()-61000)}));
 for(const [failureScope,retryScope]of [['book-small-review:writing-review-grammar','request'],['/notes','operation']])await assert.rejects(checkFailureCooldown(requests([failures]),'test',now,{failureScope,contentHash:'test-hash'}),error=>{
  assert.equal(error.details.retryScope,retryScope);assert.equal(error.details.retryAfterSeconds,839);assert.equal(error.status,429);return true;
 });
});
test('account pause identifies account scope and service pause uses remaining failure-window time',async()=>{
 const failures=count=>Array.from({length:count},()=>({createdAt:new Date(now.getTime()-110000)}));
 await assert.rejects(checkFailureCooldown(requests([[],failures(5)]),'test',now),error=>{assert.equal(error.details.retryScope,'account');assert.equal(error.details.retryAfterSeconds,790);return true;});
 await assert.rejects(checkFailureCooldown(requests([[],[],failures(20)]),'test',now),error=>{assert.equal(error.details.retryScope,'service');assert.equal(error.details.retryAfterSeconds,190);assert.equal(error.status,503);return true;});
 await assert.doesNotReject(checkFailureCooldown(requests([[],[],failures(19)]),'test',now));
});
