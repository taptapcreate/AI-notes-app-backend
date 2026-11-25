const { CreditError } = require('./credit-policy');
// Failures retain their records after refund, so changing request IDs or restarting
// the service cannot reset these cooldowns. Cached receipts bypass these checks.
async function checkFailureCooldown(Request, code, now) {
    const recent = {
        state: 'failed',
        createdAt: { $gte: new Date(now.getTime() - 15 * 60000) },
    };
    if ((await Request.countDocuments({ ...recent, recoveryCode: code })) >= 3)
        throw new CreditError(
            429,
            'AI requests are paused after repeated failures. Please try again in 15 minutes. Your credits have not been charged.',
            { code: 'AI_FAILURE_COOLDOWN', retryAfterSeconds: 900 },
        );
    if (
        (await Request.countDocuments({
            state: 'failed',
            httpStatus: { $gte: 500 },
            createdAt: { $gte: new Date(now.getTime() - 5 * 60000) },
        })) >= 20
    )
        throw new CreditError(
            503,
            'AI processing is temporarily paused after repeated failures. Please try again in 5 minutes. Your credits have not been charged.',
            { code: 'AI_FAILURE_COOLDOWN', retryAfterSeconds: 300 },
        );
}
async function checkConcurrentRequests(Request, code, now, session) {
    if (
        (await Request.countDocuments({
            recoveryCode: code,
            state: 'pending',
            leaseUntil: { $gt: now },
        }).session(session)) >= 2
    )
        throw new CreditError(
            429,
            'Two AI requests are already running. Wait for one to finish before starting another.',
            { code: 'AI_CONCURRENCY_LIMIT' },
        );
}
async function checkUnchangedReviewLimit(Request, code, bodyHash, now) {
    if (
        (await Request.countDocuments({
            recoveryCode: code,
            bodyHash,
            state: 'unchanged',
            createdAt: { $gte: new Date(now.getTime() - 24 * 60 * 60000) },
        })) >= 2
    )
        throw new CreditError(
            429,
            'This exact text already passed review with no changes needed. Edit the text before running another review.',
            { code: 'UNCHANGED_REVIEW_LIMIT', retryAfterSeconds: 3600 },
        );
    if (
        (await Request.countDocuments({
            recoveryCode: code,
            state: 'unchanged',
            createdAt: { $gte: new Date(now.getTime() - 15 * 60000) },
        })) >= 6
    )
        throw new CreditError(
            429,
            'Too many consecutive no-change reviews were requested in a short time. Wait a few minutes or edit your text before trying again.',
            { code: 'UNCHANGED_REVIEW_COOLDOWN', retryAfterSeconds: 900 },
        );
}
module.exports = { checkFailureCooldown, checkConcurrentRequests, checkUnchangedReviewLimit };
