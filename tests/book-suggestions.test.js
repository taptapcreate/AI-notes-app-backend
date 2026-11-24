const { test } = require('node:test');
const assert = require('node:assert/strict');
const { suggestionContext, suggestionCost, suggestionResult, suggestionPrompt } = require('../services/book-suggestions');
const { generationUnits } = require('../services/media-note-billing');
const { validateInput, validResult } = require('../services/generation');
const context = { task:'book-suggestions-alternatives', book:'A story', template:'fiction', language:'English', length:'paragraph', count:3, includeContext:false, selectedPassage:'The monster waited.' };
const request = extra => { const value={...context,...extra}; return { bookSuggestionsVersion:1, bookSuggestionQuote:suggestionCost(value,value.selectedPassage), type:'text', content:JSON.stringify(value) }; };
test('backend computes each price from manuscript scope and refuses an underquote or a stripped capability marker', async () => {
 for (const extra of [{}, {selectedPassage:'word '.repeat(201)}, {length:'page'}, {includeContext:true,previousParagraph:'Before',nextParagraph:'After'}]) {
  const body=request(extra); assert.equal(await generationUnits('/notes',body),body.bookSuggestionQuote); validateInput('/notes',body);
 }
 assert.throws(()=>suggestionContext({...request({length:'page'}),bookSuggestionQuote:1}),/price changed/);
 assert.throws(()=>validateInput('/notes',{...request({}),bookSuggestionsVersion:undefined}),/updated desktop/);
 assert.throws(()=>validateInput('/followup',request({})),/notes endpoint/);
 assert.throws(()=>validateInput('/notes',request({currentDraft:'Unapproved whole chapter'})));
 assert.throws(()=>validateInput('/notes',request({previousParagraph:'Unapproved context'})));
});
test('server builds a dedicated manuscript prompt and accepts exactly the requested usable result count', () => {
 const body=request({}); const value=suggestionContext(body);
 assert.match(suggestionPrompt(value), /not a continuation/); assert.match(suggestionPrompt(value), /SOURCE|MANUSCRIPT DATA/);
 const options=Array.from({length:3},(_,i)=>({title:`Option ${i}`,text:`A distinct replacement ${i}.`}));
 assert.equal(validResult('/notes',{notes:JSON.stringify({options})},body),true);
 for (const notes of ['ordinary notes',JSON.stringify({options:[options[0]]}),JSON.stringify({options:[options[0],options[0],options[0]]})])
  assert.equal(validResult('/notes',{notes},body),false);
 const expand=request({task:'book-suggestions-expand',count:1});
 assert.equal(suggestionResult(JSON.stringify({options:[options[0]]}),suggestionContext(expand)).length,1);
});

test('installed desktop suggestion requests remain compatible with their previous one-credit policy', async () => {
 const legacy={featurePolicyVersion:1,noteLength:'in-depth',type:'text',content:JSON.stringify({task:'book-suggestions-expand',currentDraft:'The monster waited.',selectedPassage:'monster'})};
 assert.equal(suggestionContext(legacy),null);
 assert.equal(await generationUnits('/notes',legacy),1);
 validateInput('/notes',legacy);
 assert.equal(validResult('/notes',{notes:'An older client validates its own structured suggestions.'},legacy),true);
});
