const { createHash, randomUUID } = require('node:crypto');
const {
    reviewBatches,
    reviewPrompt,
    reviewResult,
    parseReviewJson,
} = require('./writing-review');
const { BookGenerationError } = require('./book-generation');
const retentionMs = 24 * 60 * 60 * 1000;
const maxChunkAttempts = 4;
const maxBatchValidationAttempts = 2;
const batchConcurrency = 3;

function createBookReview({
    Checkpoint,
    GenerationRequest,
    generate,
    model,
    getRequest = () => ({}),
    now = () => new Date(),
}) {
    return async function run(context) {
        const batches = reviewBatches(context);
        const request = getRequest() || {};
        request.bookOperation = context.task;
        request.batchCount = batches.length;
        const wrapReviewError = (error, fallback = 'The AI review could not be validated.') => {
            if (error instanceof BookGenerationError) return error;
            if (error?.name === 'AbortError' || request.signal?.aborted) return error;
            const status = Number.isInteger(error?.status) && error.status >= 400 ? error.status : 502;
            const message =
                error instanceof SyntaxError
                    ? 'The AI returned an unreadable review. Your credits are returned.'
                    : /Empty AI completion|Incomplete AI stream|APIConnection|timeout/i.test(error?.message || error?.name || '')
                      ? 'AI Notes could not complete this writing review right now. Your credits are returned. Please try again.'
                      : error?.message || fallback;
            return new BookGenerationError(message, 'BOOK_REVIEW_INVALID', status);
        };
        const nonRetryableValidation = (message = '') =>
            /exceeds the chapter size limit|Choose valid/i.test(message);
        const pruneUnsafeBatchEdits = (rawText, batch) => {
            if (!Array.isArray(batch?.segments) || batch.segments.length < 4) return null;
            let parsed;
            try {
                parsed = parseReviewJson(rawText);
            } catch {
                return null;
            }
            if (!parsed || !Array.isArray(parsed.edits) || parsed.edits.length < 2) return null;
            const maxDrops = Math.max(2, Math.floor(parsed.edits.length * 0.2));
            const safeEdits = [];
            let dropped = 0;
            const itemContext = {
                ...batch,
                task: batch.task === 'writing-review-revise' ? 'writing-review-improve' : batch.task,
                pages: undefined,
            };
            for (const edit of parsed.edits) {
                try {
                    reviewResult(JSON.stringify({ edits: [edit] }), itemContext);
                    safeEdits.push(edit);
                } catch {
                    dropped++;
                    if (dropped > maxDrops) return null;
                }
            }
            // Strip any boundary-coupled edit pair still failing adjacent cross-segment rules.
            while (safeEdits.length > 0 && dropped <= maxDrops) {
                try {
                    const validated = reviewResult(JSON.stringify({ edits: safeEdits }), batch);
                    request.droppedUnsafeEdits = (request.droppedUnsafeEdits || 0) + dropped;
                    return validated.edits;
                } catch (err) {
                    const idxMap = new Map(batch.segments.map((s, i) => [s.id, i]));
                    let removedPair = false;
                    for (let i = 0; i < safeEdits.length; i++) {
                        try {
                            reviewResult(JSON.stringify({ edits: [safeEdits[i]] }), itemContext);
                        } catch {
                            safeEdits.splice(i, 1);
                            dropped++;
                            removedPair = true;
                            break;
                        }
                        if (i + 1 < safeEdits.length) {
                            const li = idxMap.get(safeEdits[i].id);
                            const ri = idxMap.get(safeEdits[i + 1].id);
                            if (li !== undefined && ri !== undefined && Math.abs(li - ri) <= 1) {
                                try {
                                    reviewResult(
                                        JSON.stringify({ edits: [safeEdits[i], safeEdits[i + 1]] }),
                                        itemContext,
                                    );
                                } catch {
                                    safeEdits.splice(i, 2);
                                    dropped += 2;
                                    removedPair = true;
                                    break;
                                }
                            }
                        }
                    }
                    if (!removedPair) return null;
                }
            }
            return null;
        };
        const maxValidationAttempts = batches.length === 1 ? 2 : maxBatchValidationAttempts;
        const runBatch = async (batch, beforeAttempt) => {
            const basePrompt = reviewPrompt(batch);
            let lastReason = '';
            for (let attempt = 0; attempt < maxValidationAttempts; attempt++) {
                if (attempt > 0) request.validationRetries = (request.validationRetries || 0) + 1;
                const prompt =
                    attempt === 0
                        ? basePrompt
                        : `IMPORTANT: Your previous response could not be validated (${lastReason}). Return ONLY valid JSON using the exact segment IDs in SOURCE.segments, keep each segment aligned strictly to its own original ID without shifting text or duplicating adjacent words, keep every line break unchanged, and keep comparable passage length.\n\n${basePrompt}`;
                let result;
                try {
                    result = await generate(8000, prompt, {
                        beforeAttempt,
                        json: true,
                    });
                } catch (error) {
                    throw wrapReviewError(error, 'AI Notes could not complete this writing review right now. Your credits are returned. Please try again.');
                }
                if (result.finishReason === 'length') {
                    lastReason = 'output truncated before finishing JSON';
                    if (
                        attempt + 1 < maxValidationAttempts &&
                        (batches.length > 1 || (request.providerCalls || 0) < 3)
                    )
                        continue;
                    throw new BookGenerationError(
                        'The revision was incomplete. Your credits are returned.',
                        'BOOK_REVIEW_INCOMPLETE',
                        502,
                    );
                }
                try {
                    return reviewResult(result.text, batch).edits;
                } catch (error) {
                    lastReason =
                        error instanceof SyntaxError
                            ? 'invalid JSON'
                            : error.message;
                    if (
                        attempt + 1 < maxValidationAttempts &&
                        !nonRetryableValidation(lastReason) &&
                        (batches.length > 1 || (request.providerCalls || 0) < 3)
                    )
                        continue;
                    if (!nonRetryableValidation(lastReason) && !(error instanceof SyntaxError)) {
                        const rescued = pruneUnsafeBatchEdits(result.text, batch);
                        if (rescued) return rescued;
                    }
                    throw wrapReviewError(error);
                }
            }
        };
        // Small operations retain one request and do not create persistent job records.
        if (batches.length === 1) {
            let singleAttempt = 0;
            const edits = await runBatch(batches[0], async () => {
                if (++singleAttempt > 4)
                    throw new BookGenerationError(
                        'The retry limit for this review was reached. Your credits are returned.',
                        'BOOK_REVIEW_RETRY_LIMIT',
                    );
            });
            return reviewResult(JSON.stringify({ edits }), context);
        }
        if (!request.accountScope || !request.generationId)
            throw new BookGenerationError(
                'The revision account could not be verified.',
            );
        request.signal?.throwIfAborted();
        await Checkpoint.init();
        const fingerprint = createHash('sha256')
            .update(
                JSON.stringify({
                    owner: request.accountScope,
                    model,
                    context,
                    prompts: batches.map(reviewPrompt),
                    outputLimit: 8000,
                }),
            )
            .digest('hex');
        const token = randomUUID();
        const fresh = () => ({
            _id: fingerprint,
            generationId: request.generationId,
            token,
            leaseUntil: new Date(
                Math.min(
                    now().getTime() + 180000,
                    request.leaseUntil?.getTime() ?? Infinity,
                ),
            ),
            expiresAt: new Date(now().getTime() + retentionMs),
            chunks: Array(batches.length).fill(null),
            attempts: Array(batches.length).fill(0),
            invalid: false,
        });
        let checkpoint;
        for (let race = 0; race < 4 && !checkpoint; race++) {
            const existing = await Checkpoint.findById(fingerprint).lean();
            if (!existing) {
                try {
                    checkpoint = (await Checkpoint.create(fresh())).toObject();
                } catch (error) {
                    if (error.code !== 11000) throw error;
                }
                continue;
            }
            const previous = await GenerationRequest.findById(
                existing.generationId,
            ).lean();
            if (
                existing.leaseUntil > now() ||
                (previous?.state === 'pending' && previous.leaseUntil > now())
            )
                throw new BookGenerationError(
                    'This revision is already running. Please wait before retrying.',
                    'BOOK_REVIEW_BUSY',
                    409,
                );
            // Explicit fresh polish after a delivered result must produce a fresh generation.
            const reset =
                existing.expiresAt <= now() ||
                ['succeeded', 'unchanged'].includes(previous?.state);
            const next = reset
                ? fresh()
                : {
                      ...fresh(),
                      expiresAt: existing.expiresAt,
                      chunks: existing.invalid
                          ? Array(batches.length).fill(null)
                          : existing.chunks,
                      attempts: existing.attempts,
                  };
            const { _id, ...fields } = next;
            checkpoint = await Checkpoint.findOneAndUpdate(
                {
                    _id: fingerprint,
                    token: existing.token,
                    leaseUntil: { $lte: now() },
                },
                { $set: fields },
                { returnDocument: 'after', runValidators: true },
            ).lean();
        }
        if (!checkpoint)
            throw new BookGenerationError(
                'The revision is updating. Please retry shortly.',
            );
        const owned = () => ({
            _id: fingerprint,
            token,
            leaseUntil: { $gt: now() },
        });
        let invalid = false;
        try {
            const results = Array(batches.length);
            const pending = [];
            let reusedChunks = 0;
            for (let index = 0; index < batches.length; index++) {
                const saved = checkpoint.chunks[index];
                // Empty edit arrays are complete, validated no-change chunks too.
                if (Array.isArray(saved)) {
                    reviewResult(
                        JSON.stringify({ edits: saved }),
                        batches[index],
                    );
                    results[index] = saved;
                    reusedChunks += 1;
                } else {
                    pending.push(index);
                }
            }
            request.reusedChunks = reusedChunks;
            const processChunk = async (index) => {
                request.signal?.throwIfAborted();
                const saved = await runBatch(batches[index], async () => {
                    request.signal?.throwIfAborted();
                    const attempt = await Checkpoint.updateOne(
                        {
                            ...owned(),
                            [`attempts.${index}`]: {
                                $lt: maxChunkAttempts,
                            },
                        },
                        { $inc: { [`attempts.${index}`]: 1 } },
                    );
                    if (attempt.modifiedCount !== 1)
                        throw new BookGenerationError(
                            'The retry limit for this unchanged draft was reached. Your credits are returned. Try later or contact support.',
                            'BOOK_REVIEW_RETRY_LIMIT',
                        );
                });
                request.signal?.throwIfAborted();
                const stored = await Checkpoint.updateOne(owned(), {
                    $set: { [`chunks.${index}`]: saved },
                });
                if (stored.modifiedCount !== 1)
                    throw new BookGenerationError(
                        'The revision was interrupted. Retry to recover completed sections.',
                    );
                results[index] = saved;
            };
            if (pending.length) {
                // Run the first pending chunk before fanning out so persistent chunk failures
                // stop at the attempt limit without burning attempts on later chunks.
                await processChunk(pending.shift());
                if (pending.length) {
                    let cursor = 0;
                    let firstError = null;
                    const workers = Array.from(
                        { length: Math.min(batchConcurrency, pending.length) },
                        async () => {
                            while (!firstError) {
                                const next = cursor++;
                                if (next >= pending.length) break;
                                try {
                                    await processChunk(pending[next]);
                                } catch (error) {
                                    firstError ||= error;
                                    break;
                                }
                            }
                        },
                    );
                    await Promise.allSettled(workers);
                    if (firstError) throw firstError;
                }
            }
            const edits = results.flat();
            let result;
            try {
                result = reviewResult(JSON.stringify({ edits }), context);
            } catch (error) {
                invalid = true;
                throw wrapReviewError(error);
            }
            return result;
        } finally {
            // Fencing prevents a late process from altering a newer attempt's checkpoint.
            await Checkpoint.updateOne(
                { _id: fingerprint, token },
                { $set: { leaseUntil: now(), invalid } },
            );
        }
    };
}
module.exports = { createBookReview, retentionMs, maxChunkAttempts };
