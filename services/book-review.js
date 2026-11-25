const { createHash, randomUUID } = require('node:crypto');
const {
    reviewBatches,
    reviewPrompt,
    reviewResult,
} = require('./writing-review');
const { BookGenerationError } = require('./book-generation');
const retentionMs = 24 * 60 * 60 * 1000;
const maxChunkAttempts = 4;

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
        const runBatch = async (batch, beforeAttempt) => {
            const result = await generate(8000, reviewPrompt(batch), {
                beforeAttempt,
            });
            if (result.finishReason === 'length')
                throw new BookGenerationError(
                    'The revision was incomplete. Your credits are returned.',
                    'BOOK_REVIEW_INCOMPLETE',
                    502,
                );
            return reviewResult(result.text, batch).edits;
        };
        // Small operations retain one request and do not create persistent job records.
        if (batches.length === 1) {
            const edits = await runBatch(batches[0]);
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
            const edits = [];
            for (let index = 0; index < batches.length; index++) {
                request.signal?.throwIfAborted();
                let saved = checkpoint.chunks[index];
                // Empty edit arrays are complete, validated no-change chunks too.
                if (!Array.isArray(saved)) {
                    saved = await runBatch(batches[index], async () => {
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
                } else
                    reviewResult(
                        JSON.stringify({ edits: saved }),
                        batches[index],
                    );
                edits.push(...saved);
            }
            let result;
            try {
                result = reviewResult(JSON.stringify({ edits }), context);
            } catch (error) {
                invalid = true;
                throw error;
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
