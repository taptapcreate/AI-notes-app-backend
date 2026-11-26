const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  reviewBatches,
  reviewContext,
  reviewPrompt,
  reviewResult,
} = require('../services/writing-review');
const { createBookReview } = require('../services/book-review');
const { createBookGenerator, BookGenerationError } = require('../services/book-generation');
const { createOpenRouter } = require('../services/openrouter');
const { suggestionPrompt, suggestionResult } = require('../services/book-suggestions');

test('sentence-aware reviewBatches avoids breaking split sentences mid-line when possible', () => {
  const segments = [];
  for (let i = 0; i < 48; i++) {
    const end = i === 44 ? 'continuing toward the' : i === 45 ? 'tall archway.' : `line number ${i}.`;
    segments.push({ id: `s${i}`, text: `${'A'.repeat(92)} ${end}` });
  }
  const batches = reviewBatches({ task: 'writing-review-improve', segments });
  assert.ok(batches.length >= 2);
  const s44Batch = batches.findIndex((b) => b.segments.some((s) => s.id === 's44'));
  const s45Batch = batches.findIndex((b) => b.segments.some((s) => s.id === 's45'));
  assert.equal(s44Batch, s45Batch, 'split sentence s44/s45 should stay inside the same batch');
  assert.ok(batches.every((b) => !b.readOnlyContext?.chapterExcerpts));
});

test('reviewResult blocks shifted segments, readOnlyContext leaks, boundary duplications and preserves literary prose', () => {
  const segments = [
    { id: 's0', text: 'If anyone peeked outside, they would see' },
    { id: 's1', text: 'nothing moving down the fogbound lane. Daniel walked on.' },
    { id: 's2', text: '“Fancy meeting you here, Inspector Vale.”' },
    { id: 's3', text: 'Her mother had been put to bed early — how could she explain it?' },
    { id: 's4', text: 'Not knowing she was watched, not knowing she was followed, Mara crossed the square.' },
  ];
  const ctx = {
    task: 'writing-review-revise',
    segments,
    readOnlyContext: {
      preceding: 'Before that, three blackbirds rose from the iron fence.',
      following: 'Later, Inspector Vale unfolded the yellowed map beside the gate.',
      chapterExcerpts: '',
    },
  };

  // Shifted dialogue overwrite rejected
  assert.throws(
    () =>
      reviewResult(
        JSON.stringify({
          edits: [
            { id: 's1', text: 'If anyone peeked outside, they would see' },
            { id: 's2', text: 'Daniel walked on.' },
          ],
        }),
        ctx,
      ),
    /shifted|omitted/i,
  );

  // readOnlyContext leak rejected
  assert.throws(
    () =>
      reviewResult(
        JSON.stringify({
          edits: [
            {
              id: 's0',
              text: 'Before that, three blackbirds rose from the iron fence. If anyone peeked outside, they would see',
            },
          ],
        }),
        ctx,
      ),
    /duplicated text from an adjacent/i,
  );

  // Legitimate stylistic polish & intentional em dashes / repetition accepted
  const good = reviewResult(
    JSON.stringify({
      edits: [
        {
          id: 's3',
          text: 'Once her mother was settled in bed for the night — how could she ever explain it?',
        },
        {
          id: 's4',
          text: 'Not knowing she was watched, not knowing she was followed, Mara slipped across the square.',
        },
      ],
    }),
    ctx,
  );
  assert.equal(good.edits.length, 2);
});

test('review prompts preserve em dashes and differentiate grammar, improve, and revise', () => {
  const ctxFor = (task) =>
    reviewContext({
      writingReviewVersion: 1,
      writingReviewPolicyVersion: 2,
      bookPageBillingVersion: 1,
      bookPageQuote: 1,
      context: JSON.stringify({
        task,
        segments: [{ id: 's0', text: 'Oliver’s favrite mug sat on the sill — cracked, yet usable.' }],
        pages: [{ number: 1, ids: ['s0'] }],
      }),
    });

  for (const task of ['writing-review-grammar', 'writing-review-improve', 'writing-review-revise']) {
    const p = reviewPrompt(ctxFor(task));
    assert.doesNotMatch(p, /over habitual em dashes/i);
    assert.match(p, /em dashes/i);
    assert.match(p, /Never shift text from one ID/i);
  }
  assert.match(reviewPrompt(ctxFor('writing-review-grammar')), /phonetic misspellings/i);
  assert.match(reviewPrompt(ctxFor('writing-review-revise')), /narrative progression|coherence, pacing/i);
});

test('createBookReview retries shifted batch response once and wraps provider failures as BookGenerationError', async () => {
  let calls = 0;
  const req = { accountScope: 'scope-1', generationId: 'gen-1', signal: new AbortController().signal };
  const ctx = {
    task: 'writing-review-revise',
    segments: [
      { id: 's0', text: 'A carriage rattled along the wet cobbles until' },
      { id: 's1', text: '“Fancy meeting you here, Inspector.”' },
    ],
    pages: [{ number: 1, ids: ['s0', 's1'] }],
  };

  const recover = createBookReview({
    Checkpoint: {},
    GenerationRequest: {},
    model: 'test',
    getRequest: () => req,
    generate: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          text: JSON.stringify({ edits: [{ id: 's1', text: 'rattled along the wet cobbles.' }] }),
          finishReason: 'stop',
        };
      }
      return {
        text: JSON.stringify({ edits: [{ id: 's1', text: '“Fancy seeing you here, Inspector.”' }] }),
        finishReason: 'stop',
      };
    },
  });
  const recovered = await recover(ctx);
  assert.equal(calls, 2);
  assert.equal(req.validationRetries, 1);
  assert.equal(recovered.edits[0].text, '“Fancy seeing you here, Inspector.”');

  // Empty AI completion is retried in bookGenerate (status=502) and wrapped cleanly as BookGenerationError
  let emptyCalls = 0;
  const router = createOpenRouter({
    chat: { completions: { create: async () => { emptyCalls += 1; return { choices: [] }; } } },
  });
  const gen = createBookGenerator({ complete: router.complete, sleep: async () => {} });
  const failing = createBookReview({
    Checkpoint: {},
    GenerationRequest: {},
    model: 'test',
    getRequest: () => ({ accountScope: 'scope-1', generationId: 'gen-2' }),
    generate: gen,
  });
  await assert.rejects(
    failing(ctx),
    (error) => error instanceof BookGenerationError && !/follow-up/i.test(error.message),
  );
  assert.equal(emptyCalls, 3);
});

test('suggestionPrompt and suggestionResult enforce factual consistency, distinct alternatives, context usage and JSON recovery', () => {
  const prompt = suggestionPrompt({
    task: 'book-suggestions-next',
    mode: 'next',
    length: 'page',
    count: 2,
    includeContext: false,
    book: 'Chronicle',
    template: 'fiction',
    language: 'English',
    brief: 'A detective returns to an old town.',
    outline: [{ title: 'Arrival', outline: 'She meets Mrs. Patel whom she knew in childhood.' }],
    previousChapters: [],
    currentDraft: 'She knocked at 4:10 PM, holding thirty-six letters from last year.',
  });
  assert.match(prompt, /verify character history/i);
  assert.match(prompt, /arithmetic against both dialogue and narration/i);
  assert.doesNotMatch(prompt, /over habitual long dashes/i);

  const recovered = suggestionResult(
    'Note:\n```json\n{"options":[{"title":"First","text":"Paragraph one.\\n\\n“Second,” she whispered."},{"title":"Second","text":"Another path."}]}\n```',
    { count: 2 },
  );
  assert.equal(recovered.length, 2);
});
