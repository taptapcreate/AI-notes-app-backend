const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const mongoose = require('mongoose');
const express = require('express');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

const User = require('../models/User');
const GenerationRequest = require('../models/GenerationRequest');
const BookReviewCheckpoint = require('../models/BookReviewCheckpoint');
const CreditRegistration = require('../models/CreditRegistration');
const PurchaseClaim = require('../models/PurchaseClaim');
const { createCredits } = require('../services/credits');
const { createGeneration } = require('../services/generation');
const { createBookReview } = require('../services/book-review');
const { createBookGenerator } = require('../services/book-generation');
const { reviewContext, reviewBatches } = require('../services/writing-review');
const { context } = require('../services/generation-context');

let mongo, config, time, credits, generation, member, calls;

before(async () => {
    mongo = await MongoMemoryReplSet.create({
        binary: { version: '8.0.17' },
        replSet: { count: 1 },
    });
    await mongoose.connect(mongo.getUri(), { dbName: 'book_phase2_billing_tests' });
    await Promise.all([
        User.init(),
        GenerationRequest.init(),
        BookReviewCheckpoint.init(),
        CreditRegistration.init(),
        PurchaseClaim.init(),
    ]);
});

after(async () => {
    await mongoose.disconnect();
    await mongo?.stop();
});

beforeEach(async () => {
    await Promise.all([
        User.deleteMany({}),
        GenerationRequest.deleteMany({}),
        BookReviewCheckpoint.deleteMany({}),
        CreditRegistration.deleteMany({}),
        PurchaseClaim.deleteMany({}),
    ]);
    config = {
        dailyFreeCreditsEnabled: false,
        freeDailyCredits: 2,
        subscriberDailyLimit: 20,
    };
    time = new Date();
    member = { isPro: true };
    calls = 0;
    credits = createCredits({
        User,
        CreditRegistration,
        PurchaseClaim,
        getAppConfig: async () => config,
        now: () => new Date(time),
    });
    generation = createGeneration({
        User,
        GenerationRequest,
        credits,
        getAppConfig: async () => config,
        entitlement: async () => member,
        now: () => new Date(time),
    });
});

const account = async () => (await credits.register({ deviceId: randomUUID() })).recoveryCode;

async function api(t, handler) {
    const app = express();
    app.use(express.json({ limit: '25mb' }));
    app.use('/api', generation.middleware);
    app.post('/api/notes', async (req, res) => {
        calls++;
        await handler(req, res);
    });
    app.post('/api/followup', async (req, res) => {
        calls++;
        await handler(req, res);
    });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(
        () =>
            new Promise((resolve) => {
                server.closeAllConnections();
                server.close(resolve);
            }),
    );
    return async (code, id, body, path = '/api/followup', headers = {}) => {
        const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${code}`,
                'Idempotency-Key': id,
                ...headers,
            },
            body: JSON.stringify(body),
        });
        return { status: response.status, body: await response.json() };
    };
}

const makeReviewBody = ({ task = 'writing-review-grammar', text = 'Clean literary sentence.', pages = 1 } = {}) => ({
    type: 'note',
    writingReviewVersion: 1,
    writingReviewPolicyVersion: 2,
    ...(pages > 1 ? { bookPageBillingVersion: 1, bookPageQuote: pages } : {}),
    context: JSON.stringify({
        task,
        segments: Array.from({ length: pages }, (_, i) => ({
            id: `s${i}`,
            text: `${text} Page ${i + 1}.`,
        })),
        ...(pages > 1
            ? { pages: Array.from({ length: pages }, (_, i) => ({ number: i + 1, ids: [`s${i}`] })) }
            : {}),
    }),
    question: `Run ${task}`,
});

const makeSuggestionBody = ({ task = 'book-suggestions-alternatives', includeContext = true, quote = 2 } = {}) => ({
    type: 'text',
    bookSuggestionsVersion: 1,
    bookSuggestionQuote: quote,
    content: JSON.stringify({
        task,
        book: 'Synthetic Test Novel',
        template: 'fiction',
        language: 'English',
        length: 'paragraph',
        count: 3,
        includeContext,
        ...(includeContext && {
            previousParagraph: 'Earlier paragraph in scene.',
            nextParagraph: 'Following paragraph in scene.',
        }),
        selectedPassage: 'The lantern flickered along the wet cobbles.',
    }),
});

test('fresh unchanged reviews bill per operation (grammar, improve, revise) and cache per-user/operation', async (t) => {
    const codeA = await account();
    const codeB = await account();
    const request = await api(t, (_req, res) => res.json({ response: JSON.stringify({ edits: [] }) }));

    const grammarBody = makeReviewBody({ task: 'writing-review-grammar', pages: 3 });
    const improveBody = makeReviewBody({ task: 'writing-review-improve', pages: 3 });
    const reviseBody = makeReviewBody({ task: 'writing-review-revise', pages: 3 });

    const r1 = await request(codeA, randomUUID(), grammarBody);
    assert.equal(r1.status, 200);
    assert.equal(r1.body.billing.charged, true);
    assert.equal(r1.body.billing.noEditsSuggested, true);
    assert.equal(r1.body.billing.totalCreditCost, 3);
    assert.equal((await credits.byCode(codeA)).dailyRequestCount, 3);

    // Duplicate unedited grammar call hits backend cache at 0 cost & 0 AI calls.
    const r2 = await request(codeA, randomUUID(), grammarBody);
    assert.equal(r2.status, 200);
    assert.equal(r2.body.billing.cached, true);
    assert.equal(r2.body.billing.charged, false);
    assert.equal(r2.body.billing.noChargeReason, 'cached-review-hit');
    assert.equal(r2.body.billing.totalCreditCost, 0);
    assert.equal(calls, 1);

    // Different operation does NOT collide with grammar cache.
    const r3 = await request(codeA, randomUUID(), improveBody);
    assert.equal(r3.status, 200);
    assert.equal(r3.body.billing.charged, true);
    assert.equal(calls, 2);

    const r4 = await request(codeA, randomUUID(), reviseBody);
    assert.equal(r4.status, 200);
    assert.equal(r4.body.billing.charged, true);
    assert.equal(calls, 3);

    // Explicit Polish again (X-AI-Regenerate: 1) bypasses content cache and bills fresh run;
    // transport retry with same Idempotency-Key does not double charge.
    const regenId = randomUUID();
    const r5 = await request(codeA, regenId, grammarBody, '/api/followup', { 'X-AI-Regenerate': '1' });
    assert.equal(r5.status, 200);
    assert.equal(r5.body.billing.charged, true);
    assert.equal(calls, 4);
    assert.equal((await credits.byCode(codeA)).dailyRequestCount, 12);

    const r5Retry = await request(codeA, regenId, grammarBody, '/api/followup', { 'X-AI-Regenerate': '1' });
    assert.equal(r5Retry.status, 200);
    assert.equal(calls, 4);
    assert.equal((await credits.byCode(codeA)).dailyRequestCount, 12);

    // Different user does NOT share cache with user A.
    const rOtherUser = await request(codeB, randomUUID(), grammarBody);
    assert.equal(rOtherUser.status, 200);
    assert.equal(rOtherUser.body.billing.charged, true);
    assert.equal(calls, 5);
});

test('Book Studio suggestions cache identically and isolate includeContext toggles and refresh requests', async (t) => {
    const code = await account();
    const options = [
        { title: 'Option 1', text: 'A distinct rewrite along the wet stones.' },
        { title: 'Option 2', text: 'Another distinct rewrite under fog.' },
        { title: 'Option 3', text: 'A third distinct rewrite past the gate.' },
    ];
    const request = await api(t, (_req, res) => res.json({ notes: JSON.stringify({ options }) }));

    const withCtx = makeSuggestionBody({ includeContext: true, quote: 2 });
    const noCtx = makeSuggestionBody({ includeContext: false, quote: 1 });

    const first = await request(code, randomUUID(), withCtx, '/api/notes');
    assert.equal(first.status, 200);
    assert.equal(first.body.billing.charged, true);
    assert.equal(first.body.billing.totalCreditCost, 2);

    const cachedSame = await request(code, randomUUID(), withCtx, '/api/notes');
    assert.equal(cachedSame.status, 200);
    assert.equal(cachedSame.body.billing.cached, true);
    assert.equal(cachedSame.body.billing.charged, false);
    assert.equal(calls, 1);

    // Toggling surrounding context off changes cost and contentHash.
    const toggledOff = await request(code, randomUUID(), noCtx, '/api/notes');
    assert.equal(toggledOff.status, 200);
    assert.equal(toggledOff.body.billing.charged, true);
    assert.equal(toggledOff.body.billing.totalCreditCost, 1);
    assert.equal(calls, 2);

    // Clicking Refresh suggestions sends X-AI-Regenerate: 1 and generates fresh options.
    const refreshed = await request(code, randomUUID(), withCtx, '/api/notes', { 'X-AI-Regenerate': '1' });
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.body.billing.charged, true);
    assert.equal(calls, 3);
    assert.equal((await credits.byCode(code)).dailyRequestCount, 5);
});

test('observability records financial metrics without leaking private manuscript prose', async (t) => {
    const code = await account();
    const secretProse = 'CONFIDENTIAL_MANUSCRIPT_TOKEN_XYZ_9981';
    const body = makeReviewBody({ text: secretProse, pages: 2 });
    const request = await api(t, (_req, res) => {
        const reqCtx = context.getStore();
        reqCtx.providerCalls = 2;
        reqCtx.inputTokens = 1200;
        reqCtx.outputTokens = 180;
        reqCtx.providerCostUSD = 0.0042;
        res.json({ response: JSON.stringify({ edits: [] }) });
    });

    const id = randomUUID();
    const res = await request(code, id, body);
    assert.equal(res.status, 200);

    const doc = await GenerationRequest.findOne({ requestId: id }).lean();
    assert.ok(doc.contentHash);
    assert.equal(doc.observability.providerCalls, 2);
    assert.equal(doc.observability.inputTokens, 1200);
    assert.equal(doc.observability.outputTokens, 180);
    assert.equal(doc.observability.creditsCharged, 2);
    assert.equal(doc.observability.noEditsSuggested, true);
    assert.equal(doc.observability.cacheHit, false);

    const serialized = JSON.stringify(doc.observability);
    assert.equal(serialized.includes(secretProse), false);
    assert.equal(serialized.includes(code), false);
});

test('single-batch retry budget prevents nested transient x validation retry amplification', async () => {
    let providerCalls = 0;
    const run = createBookReview({
        Checkpoint: BookReviewCheckpoint,
        GenerationRequest,
        model: 'mock',
        getRequest: () => ({}),
        generate: async () => {
            providerCalls++;
            return { text: 'not valid json output', finishReason: 'stop' };
        },
    });
    const ctx = reviewContext({
        context: JSON.stringify({
            task: 'writing-review-grammar',
            segments: [{ id: 's0', text: 'One short synthetic sentence.' }],
        }),
    });
    await assert.rejects(() => run(ctx));
    assert.ok(providerCalls <= 3, `expected <= 3 calls, got ${providerCalls}`);
});

test('long-form book generator caps combined transient and validation retries', async () => {
    let callsCount = 0;
    const reqCtx = {};
    const gen = createBookGenerator({
        Checkpoint: BookReviewCheckpoint,
        model: 'mock',
        getRequest: () => reqCtx,
        generate: async () => {
            callsCount++;
            throw new Error('503 Service temporarily unavailable');
        },
    });
    await assert.rejects(() => gen(1500, 'Draft chapter outline.'));
    assert.ok(callsCount <= 3, `expected capped transient calls, got ${callsCount}`);
});

test('mixed empty pages are rejected while empty chapter draft generation costs 1 credit', async (t) => {
    const code = await account();
    const request = await api(t, (_req, res) =>
        res.json({ notes: '# Chapter One\n\nA freshly drafted opening scene.' }),
    );

    // Invalid empty segment page in review payload fails validation before billing/provider.
    const invalidReview = {
        type: 'note',
        writingReviewVersion: 1,
        writingReviewPolicyVersion: 2,
        bookPageBillingVersion: 1,
        bookPageQuote: 2,
        context: JSON.stringify({
            task: 'writing-review-grammar',
            pages: [
                { number: 1, ids: ['s0'] },
                { number: 2, ids: [] },
            ],
            segments: [{ id: 's0', text: 'Only page one has prose.' }],
        }),
        question: 'Review selected pages.',
    };
    const rejected = await request(code, randomUUID(), invalidReview, '/api/followup');
    assert.equal(rejected.status, 400);
    assert.equal(calls, 0);

    // Draft Chapter with empty draft (outline only) is allowed and bills 1 credit.
    const draftBody = {
        type: 'text',
        format: 'book',
        noteLength: 'in-depth',
        content: 'Outline: A clockmaker notices the town square chime skips an hour.',
    };
    const drafted = await request(code, randomUUID(), draftBody, '/api/notes');
    assert.equal(drafted.status, 200);
    assert.equal(drafted.body.billing.charged, true);
    assert.equal(drafted.body.billing.totalCreditCost, 1);
    assert.equal(calls, 1);
});

test('multi-batch checkpoint recovery reuses completed chunks without charging or re-calling them', async (t) => {
    const code = await account();
    const segs = Array.from({ length: 6 }, (_, i) => ({
        id: `s${i}`,
        text: `The traveler inspected synthetic marker ${i}. `.repeat(35),
    }));
    const body = {
        type: 'note',
        writingReviewVersion: 1,
        writingReviewPolicyVersion: 2,
        bookPageBillingVersion: 1,
        bookPageQuote: 6,
        context: JSON.stringify({
            task: 'writing-review-revise',
            pages: Array.from({ length: 6 }, (_, i) => ({ number: i + 1, ids: [`s${i}`] })),
            segments: segs,
        }),
        question: 'Revise chapter.',
    };
    const batches = reviewBatches(reviewContext(body)).length;
    assert.ok(batches >= 2);
    let callsSeen = 0;
    const run = createBookReview({
        Checkpoint: BookReviewCheckpoint,
        GenerationRequest,
        model: 'mock',
        getRequest: () => context.getStore(),
        generate: async (_limit, prompt, { beforeAttempt }) => {
            await beforeAttempt?.();
            callsSeen++;
            if (callsSeen === batches) throw new Error('Simulated batch interruption');
            const parsed = JSON.parse(prompt.split('SOURCE: ')[1]);
            return {
                text: JSON.stringify({
                    edits: parsed.segments.map((s) => ({
                        id: s.id,
                        text: s.text.replace('traveler', 'Chronicler'),
                    })),
                }),
                finishReason: 'stop',
            };
        },
    });
    const request = await api(t, async (req, res) => {
        try {
            const result = await run(reviewContext(req.body));
            res.json({ response: JSON.stringify(result) });
        } catch (err) {
            res.status(502).json({ error: err.message });
        }
    });
    const failed = await request(code, randomUUID(), body);
    assert.equal(failed.status, 502);
    assert.equal(failed.body.billing.charged, false);

    const resumedId = randomUUID();
    const resumed = await request(code, resumedId, body);
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.billing.charged, true);
    assert.equal(callsSeen, batches + 1);
    const doc = await GenerationRequest.findOne({ requestId: resumedId }).lean();
    assert.equal(doc.observability.reusedChunks, batches - 1);
});


test('concise legitimate edits pass reviewResult while real omissions remain blocked, and unrecoverable edits fail without silently delivering partial results', async () => {
    const { reviewResult } = require('../services/writing-review');
    const ctx = {
        task: 'writing-review-improve',
        segments: [
            { id: 's0', text: 'He was in a very good mood until lunchtime.' },
            { id: 's1', text: 'She walked very slowly down the long and winding cobbled street toward home.' },
            { id: 's2', text: 'Very, very bright.' },
        ],
    };
    const validConcise = {
        edits: [
            { id: 's0', text: 'He remained cheerful until lunch.' },
            { id: 's1', text: 'She strolled down the winding cobbled street toward home.' },
            { id: 's2', text: 'Radiant.' },
        ],
    };
    assert.equal(reviewResult(JSON.stringify(validConcise), ctx).edits.length, 3);

    assert.throws(
        () =>
            reviewResult(
                JSON.stringify({
                    edits: [{ id: 's1', text: 'She went home.' }],
                }),
                ctx,
            ),
        /omitted too much/,
    );

    const batchCtx = reviewContext({
        writingReviewVersion: 1,
        writingReviewPolicyVersion: 2,
        bookPageBillingVersion: 1,
        bookPageQuote: 4,
        context: JSON.stringify({
            task: 'writing-review-revise',
            pages: Array.from({ length: 4 }, (_, i) => ({ number: i + 1, ids: [`s${i}`] })),
            segments: [
                { id: 's0', text: 'First page has a very simple grammatical mistake here.' },
                { id: 's1', text: 'Second page also have a clear verb agreement error.' },
                { id: 's2', text: 'Third page contain another obvious grammatical mistake right here.' },
                { id: 's3', text: 'The report says that Mira and Daniel Vale are — are — that they are — missing from the station.' },
            ],
        }),
    });
    const reqState = {};
    const isolatedRun = createBookReview({
        Checkpoint: BookReviewCheckpoint,
        GenerationRequest,
        model: 'mock',
        getRequest: () => reqState,
        generate: async () => ({
            text: JSON.stringify({
                edits: [
                    { id: 's0', text: 'First page has a simple grammatical mistake here.' },
                    { id: 's1', text: 'Second page also has a clear verb agreement error.' },
                    { id: 's2', text: 'Third page contains another obvious grammatical mistake right here.' },
                    { id: 's3', text: 'The report says Mira missing.' },
                ],
            }),
            finishReason: 'stop',
        }),
    });
    await assert.rejects(isolatedRun(batchCtx), /omitted too much/);
    assert.equal(reqState.droppedUnsafeEdits, undefined);
});

test('three bulk review validation failures pause further bulk reviews with dynamic retryAfterSeconds without blocking small reviews, suggestions, or Smart Notes', async (t) => {
    const code = await account();
    const request = await api(t, (_req, res) => {
        if (_req.path.endsWith('/notes')) return res.json({ notes: 'Smart Note ok' });
        if (_req.body.writingReviewVersion === 1 && (_req.body.bookPageQuote || 1) === 1) {
            return res.json({ response: JSON.stringify({ edits: [{ id: 's0', text: 'Fixed cleanly.' }] }) });
        }
        return res.status(502).json({ error: 'The AI review omitted too much of a passage. Your text is unchanged.', code: 'BOOK_REVIEW_INVALID' });
    });

    const bulkBody = makeReviewBody({ task: 'writing-review-revise', pages: 5 });
    for (let i = 0; i < 3; i++) {
        const failed = await request(code, randomUUID(), bulkBody, '/api/followup');
        assert.equal(failed.status, 502);
    }

    // Advance 5 minutes so dynamic retryAfterSeconds reflects remaining ~10 minutes.
    time = new Date(time.getTime() + 5 * 60000);
    const bulkBlocked = await request(code, randomUUID(), bulkBody, '/api/followup');
    assert.equal(bulkBlocked.status, 429);
    assert.equal(bulkBlocked.body.code, 'AI_FAILURE_COOLDOWN');
    assert.ok(bulkBlocked.body.retryAfterSeconds > 500 && bulkBlocked.body.retryAfterSeconds <= 600);
    assert.match(bulkBlocked.body.error, /10 minutes/);

    // Unrelated features must stay available:
    const singlePage = await request(code, randomUUID(), makeReviewBody({ task: 'writing-review-grammar', pages: 1 }), '/api/followup');
    assert.equal(singlePage.status, 200);
    const smartNote = await request(code, randomUUID(), { type: 'text', content: 'Ordinary note text.' }, '/api/notes');
    assert.equal(smartNote.status, 200);
});

test('provider policy rejection (HTTP 400) does not trigger failure cooldown or block subsequent operations', async (t) => {
    // A provider-side HTTP 400 (policy rejection) is deterministic — retrying with the same
    // prompt will never succeed. It must NOT count toward the scoped failure cooldown that
    // blocks unrelated operations, since doing so would prevent the user from using other
    // tools after any single policy-flagged request.
    const code = await account();
    const request = await api(t, (_req, res) => {
        if (_req.body.writingReviewVersion === 1 && (_req.body.bookPageQuote || 1) === 1) {
            // Single-page requests succeed.
            return res.json({ response: JSON.stringify({ edits: [{ id: 's0', text: 'Fixed cleanly.' }] }) });
        }
        // Simulate provider HTTP 400 policy rejection on bulk improve reviews.
        return res.status(400).json({ error: '400 Invalid prompt: your prompt was flagged as potentially violating our usage policy.', code: 'PROVIDER_POLICY_REJECTION' });
    });

    const bulkImproveBody = makeReviewBody({ task: 'writing-review-improve', pages: 5 });

    // Three repeated provider 400s — these must NOT trigger the failure cooldown.
    for (let i = 0; i < 3; i++) {
        const failed = await request(code, randomUUID(), bulkImproveBody, '/api/followup');
        assert.equal(failed.status, 400);
        assert.equal(failed.body.code, 'PROVIDER_POLICY_REJECTION');
    }

    // A fourth bulk request must NOT be blocked by cooldown (policy rejections are excluded).
    const fourthBulk = await request(code, randomUUID(), bulkImproveBody, '/api/followup');
    assert.equal(fourthBulk.status, 400); // Still rejected by provider, but not 429 cooldown.
    assert.notEqual(fourthBulk.body.code, 'AI_FAILURE_COOLDOWN');

    // Single-page and other operations must remain fully available.
    const singlePage = await request(code, randomUUID(), makeReviewBody({ task: 'writing-review-grammar', pages: 1 }), '/api/followup');
    assert.equal(singlePage.status, 200);
});

test('provider policy rejections do not interfere with separate transient-failure cooldown that uses BOOK_REVIEW_INVALID', async (t) => {
    // Three real transient failures (502 BOOK_REVIEW_INVALID) must still trigger the cooldown.
    // Interleaved provider 400s (PROVIDER_POLICY_REJECTION) must not reset or extend it.
    const code = await account();
    let callCount = 0;
    const request = await api(t, (_req, res) => {
        if (_req.body.writingReviewVersion === 1 && (_req.body.bookPageQuote || 1) === 1) {
            return res.json({ response: JSON.stringify({ edits: [{ id: 's0', text: 'Fixed cleanly.' }] }) });
        }
        callCount++;
        if (callCount % 2 === 0) {
            // Even calls: provider 400 (must not count toward cooldown).
            return res.status(400).json({ error: 'Policy rejection.', code: 'PROVIDER_POLICY_REJECTION' });
        }
        // Odd calls: transient 502 (counts toward cooldown).
        return res.status(502).json({ error: 'The AI review omitted too much of a passage. Your text is unchanged.', code: 'BOOK_REVIEW_INVALID' });
    });

    const bulkBody = makeReviewBody({ task: 'writing-review-revise', pages: 5 });
    // 3 transient failures interleaved with 3 policy rejections (6 calls total).
    for (let i = 0; i < 6; i++) {
        await request(code, randomUUID(), bulkBody, '/api/followup');
    }
    // After 3 transient failures the cooldown should be active.
    const blocked = await request(code, randomUUID(), bulkBody, '/api/followup');
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.code, 'AI_FAILURE_COOLDOWN');
});

test('createBookGenerator and createBookReview do not retry provider HTTP 400 policy rejections', async () => {
    const { createBookGenerator, BookGenerationError } = require('../services/book-generation');
    let providerCalls = 0;
    const reqState = { accountScope: 'scope-400', generationId: 'gen-400', retryCount: 0, validationRetries: 0 };
    const generate = createBookGenerator({
        complete: async () => {
            providerCalls += 1;
            const err = new Error('400 Invalid prompt: your prompt was flagged as potentially violating our usage policy.');
            err.status = 400;
            throw err;
        },
        getRequest: () => reqState,
        sleep: async () => {
            throw new Error('HTTP 400 must not sleep/retry');
        },
        onRetry: () => {
            reqState.retryCount += 1;
        },
    });
    const run = createBookReview({
        Checkpoint: {},
        GenerationRequest: {},
        generate,
        model: 'mock',
        getRequest: () => reqState,
    });
    const ctx = {
        task: 'writing-review-improve',
        segments: [
            { id: 's0', text: 'A lantern swung gently from the iron hook beside the boathouse door as rain tapped the timber roof.' },
        ],
        pages: [{ number: 1, ids: ['s0'] }],
    };
    await assert.rejects(
        () => run(ctx),
        (err) => err instanceof BookGenerationError && err.status === 400 && err.code === 'PROVIDER_POLICY_REJECTION' && /published copyrighted books/i.test(err.message),
    );
    assert.equal(providerCalls, 1);
    assert.equal(reqState.retryCount, 0);
    assert.equal(reqState.validationRetries, 0);
});

test('createBookReview surfaces content_filter truncation as PROVIDER_POLICY_REJECTION without splitting or retrying', async () => {
    const { BookGenerationError } = require('../services/book-generation');
    const { createBookReview } = require('../services/book-review');
    let calls = 0;
    const reqState = { accountScope: 'scope-filter', generationId: 'gen-filter', retryCount: 0, validationRetries: 0 };
    const run = createBookReview({
        Checkpoint: {},
        GenerationRequest: {},
        generate: async () => {
            calls += 1;
            return { text: '{"edits":[{"id":"s0","text":"partial filtered', finishReason: 'content_filter' };
        },
        model: 'mock',
        getRequest: () => reqState,
    });
    const ctx = {
        task: 'writing-review-revise',
        segments: [
            { id: 's0', text: 'A lantern swung gently from the iron hook beside the boathouse door as rain tapped the timber roof.' },
            { id: 's1', text: 'Second paragraph for split eligibility checks if content filtering wrongly retries.' },
        ],
        pages: [{ number: 1, ids: ['s0', 's1'] }],
    };
    await assert.rejects(
        () => run(ctx),
        (err) => err instanceof BookGenerationError && err.status === 400 && err.code === 'PROVIDER_POLICY_REJECTION' && /published copyrighted books/i.test(err.message),
    );
    assert.equal(calls, 1);
    assert.equal(reqState.validationRetries, 0);
});

test('successful-result cache invalidates on server model changes without mixing editing modes', async t => {
    const code = await account(); const body = makeReviewBody();
    const request = await api(t, (_req, res) => res.json({ response: '{"edits":[]}' }));
    const first = await request(code, randomUUID(), body); assert.equal(first.status, 200);
    const router = require('../services/openrouter'); const before = router.MODEL;
    try {
        router.MODEL = 'test-updated-model';
        const fresh = await request(code, randomUUID(), body); assert.equal(fresh.status, 200); assert.equal(fresh.body.billing.charged, true);
        assert.equal(calls, 2);
    } finally { router.MODEL = before; }
});

test('checkpoint refusals do not count as provider outages or block unrelated operations', async t => {
    const code = await account();
    const request = await api(t, (req, res) => req.path.endsWith('/notes') ? res.json({notes:'A valid ordinary note.'}) : res.status(429).json({error:'Review retry budget paused. Your credits are returned.', code:'BOOK_REVIEW_RETRY_LIMIT', retryAfterSeconds:60}));
    for (let i = 0; i < 6; i++) assert.equal((await request(code,randomUUID(),makeReviewBody({pages:5}))).status,429);
    assert.equal((await request(code,randomUUID(),{type:'text',content:'An ordinary note.'},'/api/notes')).status,200);
});

test('zero-provider internal failures cannot trigger the service-wide provider circuit',async t=>{
 const code=await account();
 await GenerationRequest.insertMany(Array.from({length:20},(_,i)=>({_id:randomUUID(),requestId:randomUUID(),recoveryCode:'OTHER-AUDIT-'+i,endpoint:'/followup',bodyHash:String(i),state:'failed',reservation:{},leaseUntil:time,createdAt:time,httpStatus:503,failureCode:'BOOK_REVIEW_RETRY_LIMIT',failureScope:'book-bulk-review',observability:{providerCalls:0}})));
 const request=await api(t,(_req,res)=>res.json({notes:'A valid ordinary note.'}));
 assert.equal((await request(code,randomUUID(),{type:'text',content:'Ordinary source.'},'/api/notes')).status,200);
});
test('actual provider expenditure on repeatedly failed validation retains account-level protection',async()=>{
 const code=await account();
 await GenerationRequest.insertMany(Array.from({length:5},(_,i)=>({_id:randomUUID(),requestId:randomUUID(),recoveryCode:code,endpoint:'/followup',bodyHash:String(i),state:'failed',reservation:{},leaseUntil:time,createdAt:time,httpStatus:502,failureCode:'BOOK_REVIEW_INVALID',failureScope:'book-bulk-review:writing-review-improve',observability:{providerCalls:2}})));
 await assert.rejects(require('../services/generation-safety').checkFailureCooldown(GenerationRequest,code,time,{failureScope:'/notes',endpoint:'/notes'}),error=>error.status===429);
});
