const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Checkpoint = require('../models/BookReviewCheckpoint');
const GenerationRequest = require('../models/GenerationRequest');
const { createBookReview } = require('../services/book-review');
const { reviewBatches } = require('../services/writing-review');
let mongo, time, request, calls, failAt;
before(async () => {
    mongo = await MongoMemoryReplSet.create({
        binary: { version: '8.0.17' },
        replSet: { count: 1 },
    });
    await mongoose.connect(mongo.getUri(), {
        dbName: 'book_review_checkpoints',
    });
    await Promise.all([Checkpoint.init(), GenerationRequest.init()]);
});
after(async () => {
    await mongoose.disconnect();
    await mongo?.stop();
});
beforeEach(async () => {
    await Promise.all([
        Checkpoint.deleteMany({}),
        GenerationRequest.deleteMany({}),
    ]);
    time = new Date();
    calls = [];
    failAt = 0;
    request = await attempt();
});
async function attempt(owner = 'owner-a') {
    const id = randomUUID(),
        leaseUntil = new Date(time.getTime() + 180000);
    await GenerationRequest.create({
        _id: id,
        recoveryCode: 'TEST-OWNER',
        requestId: id,
        endpoint: '/followup',
        bodyHash: id,
        state: 'pending',
        reservation: {},
        leaseUntil,
    });
    return {
        accountScope: owner,
        generationId: id,
        leaseUntil,
        signal: new AbortController().signal,
    };
}
const context = () => ({
    task: 'writing-review-revise',
    pages: Array.from({ length: 8 }, (_, i) => ({
        number: i + 1,
        ids: ['s' + i],
    })),
    segments: Array.from({ length: 8 }, (_, i) => ({
        id: 's' + i,
        text: (
            'Passage ' +
            i +
            ' follows the traveler through the city. '
        ).repeat(25),
    })),
});
function runner(model = 'test-model') {
    return createBookReview({
        Checkpoint,
        GenerationRequest,
        model,
        now: () => new Date(time),
        getRequest: () => request,
        generate: async (_cap, prompt, { beforeAttempt } = {}) => {
            await beforeAttempt?.();
            const batch = JSON.parse(prompt.split('SOURCE: ')[1]);
            calls.push(batch.segments.map((s) => s.id));
            if (failAt && calls.length === failAt)
                throw Error('Provider failed');
            return {
                text: JSON.stringify({
                    edits: batch.segments.map((s) => ({
                        id: s.id,
                        text: s.text.replaceAll('traveler', 'writer'),
                    })),
                }),
                finishReason: 'stop',
            };
        },
    });
}
test('late failure persists completed chunks; a new request resumes only the missing sections', async () => {
    const ctx = context(),
        run = runner(),
        batches = reviewBatches(ctx);
    failAt = batches.length;
    await assert.rejects(run(ctx), /Provider failed/);
    const first = request;
    await GenerationRequest.updateOne(
        { _id: first.generationId },
        { $set: { state: 'failed' } },
    );
    request = await attempt();
    const result = await run(ctx);
    assert.equal(result.edits.length, ctx.segments.length);
    assert.equal(calls.length, batches.length + 1);
    assert.equal(calls.filter((c) => c.includes('s0')).length, 1);
    const record = await Checkpoint.findOne().lean();
    assert.equal(record.expiresAt - time, 86400000);
    assert.equal(record.recoveryCode, undefined);
    assert.equal(record.context, undefined);
    assert.equal(record.prompt, undefined);
});
test('delivered successful reviews start fresh on explicit new polish and other owners cannot reuse edits', async () => {
    const ctx = context(),
        run = runner(),
        n = reviewBatches(ctx).length;
    await run(ctx);
    await GenerationRequest.updateOne(
        { _id: request.generationId },
        { $set: { state: 'succeeded' } },
    );
    request = await attempt();
    await run(ctx);
    assert.equal(calls.length, n * 2);
    request = await attempt('owner-b');
    await run(ctx);
    assert.equal(calls.length, n * 3);
    assert.equal(await Checkpoint.countDocuments(), 2);
});
test('active requests block duplicate generation even after chunk work has finished but billing is pending', async () => {
    const run = runner();
    await run(context());
    request = await attempt();
    await assert.rejects(
        run(context()),
        (error) => error.code === 'BOOK_REVIEW_BUSY',
    );
});
test('a changed model or draft invalidates old checkpoints', async () => {
    const run = runner();
    failAt = 2;
    await assert.rejects(run(context()));
    await GenerationRequest.updateOne(
        { _id: request.generationId },
        { $set: { state: 'failed' } },
    );
    request = await attempt();
    await runner('new-model')(context());
    assert.equal(await Checkpoint.countDocuments(), 2);
    const changed = context();
    changed.segments[0].text += ' A new fact.';
    request = await attempt();
    await run(changed);
    assert.equal(await Checkpoint.countDocuments(), 3);
});
test('expired processing can be reclaimed after a restart and expired content is regenerated', async () => {
    const run = runner();
    failAt = 2;
    await assert.rejects(run(context()));
    time = new Date(time.getTime() + 180001);
    request = await attempt();
    await run(context());
    assert.equal(calls.filter((c) => c.includes('s0')).length, 1);
    time = new Date(time.getTime() + 86400001);
    request = await attempt();
    await run(context());
    assert.equal(calls.filter((c) => c.includes('s0')).length, 2);
});
test('repeated failures stop at the persistent per-chunk attempt budget', async () => {
    const run = createBookReview({
        Checkpoint,
        GenerationRequest,
        model: 'test',
        now: () => new Date(time),
        getRequest: () => request,
        generate: async (_cap, _prompt, { beforeAttempt } = {}) => {
            await beforeAttempt?.();
            calls.push('call');
            throw Error('Provider failed');
        },
    });
    for (let i = 0; i < 5; i++) {
        await assert.rejects(
            run(context()),
            i < 4 ? /Provider failed/ : (error) => error.code === 'BOOK_REVIEW_RETRY_LIMIT' && error.retryAfterSeconds > 0,
        );
        await GenerationRequest.updateOne(
            { _id: request.generationId },
            { $set: { state: 'failed' } },
        );
        request = await attempt();
    }
    assert.equal(calls.length, 4);
});
test('small reviews keep the lightweight path and cancellation creates no checkpoint or provider call', async () => {
    const ctx = context();
    ctx.segments = ctx.segments.slice(0, 1);
    ctx.pages = ctx.pages.slice(0, 1);
    await runner()(ctx);
    assert.equal(await Checkpoint.countDocuments(), 0);
    const abort = new AbortController();
    abort.abort();
    request.signal = abort.signal;
    await assert.rejects(runner()(context()));
    assert.equal(calls.length, 1);
});

test('completed no-change chunks are reused rather than regenerated', async () => {
    const n = reviewBatches(context()).length;
    let index = 0;
    const run = createBookReview({
        Checkpoint,
        GenerationRequest,
        model: 'empty',
        now: () => new Date(time),
        getRequest: () => request,
        generate: async (_cap, _prompt, { beforeAttempt }) => {
            await beforeAttempt?.();
            index++;
            if (index === n) throw Error('Failed last');
            return { text: '{"edits":[]}', finishReason: 'stop' };
        },
    });
    await assert.rejects(run(context()), /Failed last/);
    await GenerationRequest.updateOne(
        { _id: request.generationId },
        { $set: { state: 'failed' } },
    );
    request = await attempt();
    assert.deepEqual(await run(context()), { edits: [] });
    assert.equal(index, n + 1);
});
test('expired workers cannot overwrite a checkpoint reclaimed by another request', async () => {
    let started, release;
    const entered = new Promise((resolve) => {
            started = resolve;
        }),
        gate = new Promise((resolve) => {
            release = resolve;
        });
    const old = request;
    const first = createBookReview({
        Checkpoint,
        GenerationRequest,
        model: 'fenced',
        now: () => new Date(time),
        getRequest: () => old,
        generate: async (_cap, prompt, { beforeAttempt }) => {
            await beforeAttempt?.();
            started();
            await gate;
            const batch = JSON.parse(prompt.split('SOURCE: ')[1]);
            return {
                text: JSON.stringify({
                    edits: batch.segments.map((s) => ({
                        id: s.id,
                        text: s.text.replaceAll('traveler', 'old worker'),
                    })),
                }),
                finishReason: 'stop',
            };
        },
    });
    const stale = first(context());
    await entered;
    time = new Date(time.getTime() + 180001);
    request = await attempt();
    const current = request;
    const fresh = createBookReview({
        Checkpoint,
        GenerationRequest,
        model: 'fenced',
        now: () => new Date(time),
        getRequest: () => current,
        generate: async (_cap, prompt, { beforeAttempt }) => {
            await beforeAttempt?.();
            const batch = JSON.parse(prompt.split('SOURCE: ')[1]);
            return {
                text: JSON.stringify({
                    edits: batch.segments.map((s) => ({
                        id: s.id,
                        text: s.text.replaceAll('traveler', 'new worker'),
                    })),
                }),
                finishReason: 'stop',
            };
        },
    });
    await fresh(context());
    release();
    await assert.rejects(stale, /interrupted/);
    const saved = await Checkpoint.findOne().lean();
    assert.equal(saved.generationId, current.generationId);
    assert(JSON.stringify(saved.chunks).includes('new worker'));
    assert(!JSON.stringify(saved.chunks).includes('old worker'));
});
test('transient validation errors retry with guidance and persistent omissions return BookGenerationError', async () => {
    const { BookGenerationError } = require('../services/book-generation');
    const ctx = context();
    let seenRetryGuidance = false;
    let firstBatchAttempt = 0;
    const retried = createBookReview({
        Checkpoint,
        GenerationRequest,
        model: 'retry-validation',
        now: () => new Date(time),
        getRequest: () => request,
        generate: async (_cap, prompt, { beforeAttempt }) => {
            await beforeAttempt?.();
            const batch = JSON.parse(prompt.split('SOURCE: ')[1]);
            if (batch.segments[0].id === 's0') {
                firstBatchAttempt++;
                if (firstBatchAttempt === 1) return { text: 'not json', finishReason: 'stop' };
                seenRetryGuidance = prompt.includes('invalid JSON');
            }
            return {
                text: JSON.stringify({
                    edits: batch.segments.map((s) => ({
                        id: s.id,
                        text: s.text.replaceAll('traveler', 'writer'),
                    })),
                }),
                finishReason: 'stop',
            };
        },
    });
    const res = await retried(ctx);
    assert.equal(res.edits.length, ctx.segments.length);
    assert.equal(seenRetryGuidance, true);
    assert.ok(request.validationRetries >= 1);

    await GenerationRequest.updateOne({ _id: request.generationId }, { $set: { state: 'failed' } });
    request = await attempt();
    const persistent = createBookReview({
        Checkpoint,
        GenerationRequest,
        model: 'persistent-omission',
        now: () => new Date(time),
        getRequest: () => request,
        generate: async (_cap, prompt, { beforeAttempt }) => {
            await beforeAttempt?.();
            const batch = JSON.parse(prompt.split('SOURCE: ')[1]);
            return {
                text: JSON.stringify({
                    edits: batch.segments.map((s) => ({ id: s.id, text: 'Too short.' })),
                }),
                finishReason: 'stop',
            };
        },
    });
    await assert.rejects(
        persistent(ctx),
        (error) =>
            error instanceof BookGenerationError &&
            error.code === 'BOOK_REVIEW_INVALID' &&
            error.status === 502 &&
            /omitted too much/.test(error.message),
    );
});
test('remaining batches run concurrently after the first batch while preserving segment order', async () => {
    const ctx = context();
    let inFlight = 0;
    let peakInFlight = 0;
    const run = createBookReview({
        Checkpoint,
        GenerationRequest,
        model: 'concurrent',
        now: () => new Date(time),
        getRequest: () => request,
        generate: async (_cap, prompt, { beforeAttempt }) => {
            await beforeAttempt?.();
            inFlight++;
            peakInFlight = Math.max(peakInFlight, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 25));
            inFlight--;
            const batch = JSON.parse(prompt.split('SOURCE: ')[1]);
            return {
                text: JSON.stringify({
                    edits: batch.segments.map((s) => ({
                        id: s.id,
                        text: s.text.replaceAll('traveler', 'voyager'),
                    })),
                }),
                finishReason: 'stop',
            };
        },
    });
    const res = await run(ctx);
    assert.ok(peakInFlight >= 2, `expected concurrent execution, saw peak ${peakInFlight}`);
    assert.deepEqual(
        res.edits.map((e) => e.id),
        ctx.segments.map((s) => s.id),
    );
});
test('30-page grammar review requests json mode and succeeds with mixed empty and corrected batches', async () => {
    const segments = Array.from({ length: 30 }, (_, i) => ({
        id: `s${i}`,
        text: (i % 6 === 0
            ? `Chapter passage ${i} have an intentional verb error. `
            : `Chapter passage ${i} reads cleanly without grammar errors. `).repeat(12),
    }));
    const ctx = {
        task: 'writing-review-grammar',
        pages: segments.map((s, i) => ({ number: i + 1, ids: [s.id] })),
        segments,
    };
    const jsonFlags = [];
    const run = createBookReview({
        Checkpoint,
        GenerationRequest,
        model: 'grammar-30',
        now: () => new Date(time),
        getRequest: () => request,
        generate: async (_cap, prompt, { beforeAttempt, json } = {}) => {
            await beforeAttempt?.();
            jsonFlags.push(Boolean(json));
            const batch = JSON.parse(prompt.split('SOURCE: ')[1]);
            const edits = batch.segments
                .filter((s) => s.text.includes('have an intentional'))
                .map((s) => ({
                    id: s.id,
                    text: s.text.replaceAll('have an intentional', 'has an intentional'),
                }));
            return {
                text: `\`\`\`json\n${JSON.stringify({ edits })}\n\`\`\``,
                finishReason: 'stop',
            };
        },
    });
    const res = await run(ctx);
    assert.ok(jsonFlags.length > 1 && jsonFlags.every(Boolean));
    assert.equal(res.edits.length, 5);
});

test('automatic retries share a bounded 15-minute chunk budget while completed chunks persist for 24 hours', async () => {
    const { createBookGenerator } = require('../services/book-generation');
    let providerCalls = 0;
    const generate = createBookGenerator({ getRequest: () => request, sleep: async () => {}, onRetry: () => request.retryCount = (request.retryCount || 0) + 1,
        complete: async () => { providerCalls++; const error = Error('Transient provider failure'); error.status = 503; throw error; } });
    const run = createBookReview({ Checkpoint, GenerationRequest, generate, model: 'budget-window', now: () => new Date(time), getRequest: () => request });
    await assert.rejects(run(context()), /Transient provider failure/);
    await GenerationRequest.updateOne({ _id: request.generationId }, { $set: { state: 'failed' } });
    request = await attempt();
    await assert.rejects(run(context()), error => error.code === 'BOOK_REVIEW_RETRY_LIMIT');
    await GenerationRequest.updateOne({ _id: request.generationId }, { $set: { state: 'failed' } });
    assert.equal(providerCalls, 4);
    const saved = await Checkpoint.findOne().lean();
    time = new Date(saved.attemptWindowEndsAt.getTime() + 1);
    request = await attempt();
    await assert.rejects(run(context()), /Transient provider failure/);
    assert.equal(providerCalls, 7);
    assert.equal(+(await Checkpoint.findOne().lean()).expiresAt, +saved.expiresAt);
});

test('lost leases are distinguished from retry exhaustion before contacting the provider', async () => {
    const run = createBookReview({ Checkpoint, GenerationRequest, model: 'lost-lease', now: () => new Date(time), getRequest: () => request,
        generate: async (_, prompt, { beforeAttempt }) => { time = new Date(time.getTime() + 180001); await beforeAttempt(); throw Error('Provider must not be called'); } });
    await assert.rejects(run(context()), error => error.code === 'BOOK_REVIEW_LEASE_LOST');
});

test('an incompatible stored chunk is repaired instead of poisoning every future review', async () => {
    const run = runner('stale-chunk'); failAt = 2;
    await assert.rejects(run(context()));
    await GenerationRequest.updateOne({ _id: request.generationId }, { $set: { state: 'failed' } });
    const saved = await Checkpoint.findOne().lean();
    await Checkpoint.updateOne({ _id: saved._id }, { $set: { 'chunks.0': [{ id: 's9999', text: 'Stale layout replacement.' }], attempts: [] } });
    request = await attempt(); failAt = 0;
    assert.equal((await run(context())).edits.length, context().segments.length);
});

test('cross-batch conflict preserves independently valid chunks and retries only affected boundaries',async()=>{
 const ctx={task:'writing-review-improve',segments:[
  {id:'s0',text:'A traveler follows the river through a quiet city. '.repeat(80)},
  {id:'s1',text:'The traveler crossed quiet streets. '.repeat(110)+'We walked toward the aged'},
  {id:'s2',text:'old bridge beside the river. '+'The lamps shone across the water. '.repeat(120)}
 ],pages:[{number:1,ids:['s0']},{number:2,ids:['s1']},{number:3,ids:['s2']}]};
 let repair=false;let providerCalls=0;const diagnostics=[];
 const run=createBookReview({Checkpoint,GenerationRequest,onValidation:event=>diagnostics.push(event),model:'boundary-recovery',getRequest:()=>request,now:()=>new Date(time),generate:async(_,prompt,{beforeAttempt})=>{
  await beforeAttempt();providerCalls++;const b=JSON.parse(prompt.split('SOURCE: ')[1]);return {text:JSON.stringify({edits:b.segments.flatMap(s=>s.id==='s0'?[{id:s.id,text:s.text.replaceAll('traveler','writer')}]:s.id==='s1'&&!repair?[{id:s.id,text:s.text.replace(/aged$/,'old')}]:[])}),finishReason:'stop'};
 }});
 assert.equal(reviewBatches(ctx).length,3);
 await assert.rejects(run(ctx),error=>{
  assert.match(error.message,/duplicated words/);
  assert.equal(error.reviewValidation.stage,'final');
  assert.equal(error.reviewValidation.reason,'boundary_duplicate_words');
  return true;
 });
 assert.equal(diagnostics.at(-1).stage,'final');
 const saved=await Checkpoint.findOne().lean();assert.ok(Array.isArray(saved.chunks[0]));assert.equal(saved.chunks[1],null);assert.equal(saved.chunks[2],null);
 await GenerationRequest.updateOne({_id:request.generationId},{$set:{state:'failed'}});request=await attempt();repair=true;
 assert.equal((await run(ctx)).edits.length,1);assert.equal(providerCalls,5);assert.equal(request.reusedChunks,1);
});

test('17-page bulk revise, grammar, and improve reviews recover when a batch returns malformed JSON via split-batch fallback', async () => {
 for (const task of ['writing-review-revise', 'writing-review-grammar', 'writing-review-improve']) {
  await Checkpoint.deleteMany({});
  await GenerationRequest.deleteMany({});
  request = await attempt();
  // ~17 pages, ~4,872 words across 68 formatted paragraphs (~280 words each? 68 * 72 = ~4,896 words)
  const para = '“Look at that old streetlamp by the iron gate,” Mira whispered while rain tapped against the windowpane and shadows stretched across the hall. She adjusted her wool coat, checked the pocket watch inside her sleeve, stepped quietly over the creaking floorboards toward the doorway, and waited for Daniel before opening the heavy wooden latch in the dim corridor.';
  const segments = Array.from({ length: 84 }, (_, i) => ({
   id: `s${i}`,
   text: `Passage ${i + 1}: ${para}`,
  }));
  const pages = Array.from({ length: 17 }, (_, p) => ({
   number: p + 1,
   ids: segments.slice(p * 5, Math.min(segments.length, (p + 1) * 5)).map((s) => s.id),
  })).filter((p) => p.ids.length);
  const ctx = { task, pages, segments };
  const batches = reviewBatches(ctx);
  assert.ok(batches.length >= 5);
  const failingBatchIds = new Set(batches[1].segments.map((s) => s.id));
  const seenSplits = [];
  const run = createBookReview({
   Checkpoint,
   GenerationRequest,
   model: `bulk-${task}`,
   now: () => new Date(time),
   getRequest: () => request,
   generate: async (_cap, prompt, { beforeAttempt }) => {
    await beforeAttempt();
    const input = JSON.parse(prompt.split('SOURCE: ')[1]);
    const ids = input.segments.map((s) => s.id);
    if (ids.length === failingBatchIds.size && ids.every((id) => failingBatchIds.has(id))) {
     return { text: '{"edits":[{"id":"' + ids[0] + '","text":"unterminated', finishReason: 'stop' };
    }
    if (ids.some((id) => failingBatchIds.has(id))) seenSplits.push(ids);
    return {
     text: JSON.stringify({
      edits: input.segments.map((s) => ({
       id: s.id,
       text: s.text.replace('iron gate', 'brass gate'),
      })),
     }),
     finishReason: 'stop',
    };
   },
  });
  const res = await run(ctx);
  assert.equal(res.edits.length, segments.length);
  assert.equal(seenSplits.length, 2, `${task} should split the failing batch into 2 halves`);
  assert.equal(seenSplits.flat().length, failingBatchIds.size);
 }
});

test('recursive depth-2 split recovery succeeds when even a half-batch triggers invalid_json without hitting retry cap', async () => {
 await Checkpoint.deleteMany({});
 await GenerationRequest.deleteMany({});
 request = await attempt();
 const segments = Array.from({ length: 12 }, (_, i) => ({
  id: `s${i}`,
  text: `Sentence ${i + 1}: "Dialogue quote," she said as rain tapped softly against the tall window.`,
 }));
 const ctx = { task: 'writing-review-revise', pages: [{ number: 1, ids: segments.map((s) => s.id) }], segments };
 const seenCalls = [];
 const run = createBookReview({
  Checkpoint,
  GenerationRequest,
  model: 'depth2-json-recovery',
  now: () => new Date(time),
  getRequest: () => request,
  generate: async (_cap, prompt, { beforeAttempt, schema }) => {
   assert.equal(schema?.name, 'writing_review');
   await beforeAttempt();
   const input = JSON.parse(prompt.split('SOURCE: ')[1]);
   seenCalls.push(input.segments.length);
   if (input.segments.length > 4) {
    return { text: '{"edits":[{"id":"s0","text":"broken', finishReason: 'stop' };
   }
   return {
    text: JSON.stringify({
     edits: input.segments.map((s) => ({ id: s.id, text: s.text.replace('softly', 'quietly') })),
    }),
    finishReason: 'stop',
   };
  },
 });
 const res = await run(ctx);
 assert.equal(res.edits.length, 12);
 assert.ok(seenCalls.some((len) => len <= 4));
});
