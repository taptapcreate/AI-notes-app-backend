const test = require('node:test');
const assert = require('node:assert/strict');
const { createOpenRouter, InvalidSource } = require('../services/openrouter');

const b64 = (text, encoding) => Buffer.from(text, encoding).toString('base64');

test('text, images, and PDFs use Luna with their original content', async () => {
    const requests = [];
    const router = createOpenRouter({
        chat: { completions: { create: async (body, options) => {
            requests.push({ body, options });
            return { choices: [{ message: { content: 'Summary' }, finish_reason: 'stop' }] };
        } } },
    });
    const signal = new AbortController().signal;
    assert.deepEqual(await router.complete('Draft a reply.', 512, signal), {
        text: 'Summary', finishReason: 'stop',
    });
    const png = b64('89504e470d0a1a0a', 'hex');
    const pdf = b64('%PDF-1.7\n');
    await router.complete(['Read the image.', { inlineData: { mimeType: 'image/jpeg', data: png } }], 900, signal);
    await router.complete(['Read the PDF.', { inlineData: { mimeType: 'application/pdf', data: pdf } }], 900, signal);

    for (const { body, options } of requests) {
        assert.equal(body.model, 'openai/gpt-6-luna');
        assert.deepEqual(body.reasoning, { effort: 'none' });
        assert.equal(options.signal, signal);
    }
    assert.equal(requests[0].body.max_completion_tokens, 512);
    assert.equal(requests[0].body.messages[0].content, 'Draft a reply.');
    assert.equal(requests[1].body.messages[0].content[1].image_url.url, `data:image/png;base64,${png}`);
    assert.equal(requests[1].body.plugins, undefined);
    assert.equal(requests[2].body.messages[0].content[1].file.file_data, `data:application/pdf;base64,${pdf}`);
    assert.deepEqual(requests[2].body.plugins, [{ id: 'file-parser', pdf: { engine: 'mistral-ocr' } }]);
});

test('voice uses Whisper and detects the recording container from the audio bytes', async () => {
    const signal = new AbortController().signal;
    const fixtures = { wav: b64('RIFF0000WAVE'), m4a: b64('0000ftypM4A '), mp3: b64('ID3audio') };
    const requests = [];
    const router = createOpenRouter({ post: async (path, options) => {
        requests.push({ path, ...options });
        return { text: '  A voice note.  ' };
    } });
    for (const audio of Object.values(fixtures)) {
        assert.equal(await router.transcribe(audio, signal), 'A voice note.');
    }
    for (const [index, [format, data]] of Object.entries(fixtures).entries()) {
        assert.equal(requests[index].path, '/audio/transcriptions');
        assert.equal(requests[index].signal, signal);
        assert.equal(requests[index].body.model, 'openai/whisper-large-v3-turbo');
        assert.deepEqual(requests[index].body.input_audio, { format, data });
    }
});

test('invalid attachments and empty upstream results fail instead of returning a billable note', async () => {
    const router = createOpenRouter({
        post: async () => ({ text: ' ' }),
        chat: { completions: { create: async () => ({ choices: [] }) } },
    });
    await assert.rejects(router.complete('Summarize.', 900), /Empty AI completion/);
    await assert.rejects(router.complete([{ inlineData: { mimeType: 'application/pdf', data: b64('not a PDF') } }], 900), InvalidSource);
    await assert.rejects(router.transcribe(b64('not audio')), InvalidSource);
    await assert.rejects(router.transcribe(b64('RIFF0000WAVE')), /No speech was detected/);
});


test('live completion publishes provider deltas before its final response using the same model', async () => {
    const requests=[], previews=[];
    let release;const waiting=new Promise(resolve=>release=resolve);
    const router=createOpenRouter({chat:{completions:{create:async body=>{
        requests.push(body);
        return (async function*(){
            yield {choices:[{delta:{content:'Hello '}}]};
            await waiting;
            yield {choices:[{delta:{content:'world 🌍'},finish_reason:'stop'}]};
        })();
    }}}});
    const result=router.complete('Source',512,undefined,text=>previews.push(text));
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(previews,['Hello ']);release();
    assert.deepEqual(await result,{text:'Hello world 🌍',finishReason:'stop'});
    assert.equal(requests.length,1);assert.equal(requests[0].stream,true);assert.equal(requests[0].model,'openai/gpt-6-luna');
});
test('upstream EOF or in-stream failure cannot become a successful note', async()=>{
    for(const ending of [null,{error:{message:'Provider failed'}},{choices:[{finish_reason:'error'}]}]){
        const router=createOpenRouter({chat:{completions:{create:async()=> (async function*(){
            yield {choices:[{delta:{content:'Partial'}}]};if(ending)yield ending;
        })()}}});
        await assert.rejects(router.complete('Source',100,undefined,()=>{}),/stream/);
    }
});

test('provider timing reports latency without source text and observers cannot discard results', async () => {
    const metrics = [];
    const router = createOpenRouter({ chat: { completions: { create: async () => (async function* () {
        yield { choices: [{ delta: { content: 'Private manuscript' } }] };
        yield { choices: [{ finish_reason: 'stop' }] };
    })() } } }, { onTiming: value => { metrics.push(value); throw new Error('observer unavailable'); } });
    const result = await router.complete('Secret source', 100, undefined, () => {});
    assert.equal(result.text, 'Private manuscript');
    assert.equal(metrics.length, 1); assert.equal(metrics[0].success, true);
    assert.ok(metrics[0].durationMs >= 0); assert.ok(metrics[0].firstTextMs >= 0);
    assert.ok(!JSON.stringify(metrics).includes('Secret source'));
    assert.ok(!JSON.stringify(metrics).includes('Private manuscript'));
});


test('provider usage is retained without manuscript text and missing usage is not reported as zero cost', async () => {
 const timing=[];
 const router=createOpenRouter({chat:{completions:{create:async()=>({usage:{prompt_tokens:120,completion_tokens:30,cost:0.00003,prompt_tokens_details:{cached_tokens:20,cache_write_tokens:100},completion_tokens_details:{reasoning_tokens:0},unexpected:'PRIVATE'},choices:[{message:{content:'Generated prose'},finish_reason:'stop'}]})}}},{onTiming:value=>timing.push(value)});
 const result=await router.complete('PRIVATE MANUSCRIPT',8000);
 assert.deepEqual(result.usage,{inputTokens:120,outputTokens:30,cachedTokens:20,cacheWriteTokens:100,reasoningTokens:0,costUSD:0.00003});
 assert.deepEqual(timing[0].usage,result.usage);assert(!JSON.stringify(timing).includes('PRIVATE'));
 const missing=await createOpenRouter({chat:{completions:{create:async()=>({choices:[{message:{content:'Text'},finish_reason:'stop'}]})}}}).complete('Text',8000);
 assert.equal(missing.usage,undefined);
});
test('json option requests OpenRouter json_object response_format without affecting default completions', async () => {
 const bodies = [];
 const router = createOpenRouter({ chat: { completions: { create: async (body) => {
  bodies.push(body);
  return { choices: [{ message: { content: '{"edits":[]}' }, finish_reason: 'stop' }] };
 } } } });
 await router.complete('Return JSON', 8000, undefined, undefined, { json: true });
 await router.complete('Return text', 8000);
 assert.deepEqual(bodies[0].response_format, { type: 'json_object' });
 assert.equal(bodies[1].response_format, undefined);
});
test('schema option sends strict json_schema and falls back once to json_object on provider schema rejection', async () => {
 const bodies = [];
 const metrics = [];
 const schema = {
  name: 'writing_review',
  strict: true,
  schema: { type: 'object', properties: { edits: { type: 'array' } }, required: ['edits'], additionalProperties: false },
 };
 const router = createOpenRouter({ chat: { completions: { create: async (body) => {
  bodies.push(body);
  if (bodies.length === 1) {
   const err = new Error('Provider does not support json_schema response_format');
   err.status = 400;
   throw err;
  }
  return { choices: [{ message: { content: '{"edits":[]}' }, finish_reason: 'stop' }] };
 } } } }, { onTiming: value => metrics.push(value) });
 const res = await router.complete('SECRET DRAFT', 8000, undefined, undefined, { json: true, schema });
 assert.equal(res.text, '{"edits":[]}');
 assert.equal(bodies.length, 2);
 assert.deepEqual(bodies[0].response_format, { type: 'json_schema', json_schema: schema });
 assert.deepEqual(bodies[1].response_format, { type: 'json_object' });
 assert.equal(metrics.at(-1).finishReason, 'stop');
 assert.equal(metrics.at(-1).outputChars, 12);
 assert.ok(!JSON.stringify(metrics).includes('SECRET'));
});
