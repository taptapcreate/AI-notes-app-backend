const {test}=require('node:test');
const assert=require('node:assert/strict');
const {validateNarration,appendNarration}=require('../services/walkthrough');
const {validateInput}=require('../services/generation');
const wav=Buffer.alloc(60);wav.write('RIFF');wav.write('WAVE',8);const audio=wav.toString('base64');
test('optional narration is bounded WAV and only accepted for notes with frames',()=>{
  validateNarration(undefined);validateNarration(audio);
  assert.throws(()=>validateNarration('eA=='),/Invalid/);
  assert.throws(()=>validateNarration('a'.repeat(5*1024*1024)),/Invalid/);
  assert.throws(()=>validateInput('/reply',{message:'hello',narration:audio}),/Narration requires/);
  validateInput('/notes',{type:'image',content:'eA==',narration:audio});
});
test('single generation combines transcript and frames; failures propagate for the existing refund flow',async()=>{
  let calls=0;const transcribe=async()=>{calls++;return 'Select Export, then PDF.';};
  assert.equal(await appendNarration('steps',undefined,transcribe),'steps');assert.equal(calls,0);
  assert.match(await appendNarration('steps',audio,transcribe),/Select Export/);assert.equal(calls,1);
  await assert.rejects(appendNarration('steps',audio,async()=>{throw new Error('provider unavailable');}),/provider unavailable/);
  await assert.rejects(appendNarration('steps',audio,async()=>''),/No narration/);
});
