const { subscriptionUsage } = require('./subscription-usage');
const { validateNarration } = require('./walkthrough');
const { createHash } = require('node:crypto');
const { context } = require('./generation-context');
const {
    CreditError,
    policy,
    balance,
    recoveryCode,
} = require('./credit-policy');

const PATHS = new Set([
    '/notes',
    '/reply',
    '/followup',
    '/translate',
    '/polish',
    '/sentiment',
]);
const REQUEST_ID =
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
function validateInput(endpoint, body) {
    if (!body || typeof body !== 'object' || Array.isArray(body))
        throw new CreditError(400, 'Invalid AI request');
    if (Buffer.byteLength(JSON.stringify(body)) > 23 * 1024 * 1024)
        throw new CreditError(413, 'The source is too large');
    if (body.billingMode !== undefined && !['free', 'purchased'].includes(body.billingMode))
        throw new CreditError(400, 'Invalid billing mode');
    const text = (value, max = 2000000) => {
        if (typeof value !== 'string' || !value.trim() || value.length > max)
            throw new CreditError(400, 'Enter valid source content');
    };
    if (body.narration !== undefined && (endpoint !== '/notes' || body.type !== 'image')) throw new CreditError(400, 'Narration requires walkthrough image frames');
    if (endpoint === '/notes') {
        try { validateNarration(body.narration); } catch (e) { throw new CreditError(400, e.message); }
        if (
            !['text', 'image', 'voice', 'pdf', 'website', 'youtube'].includes(
                body.type,
            )
        )
            throw new CreditError(400, 'Unsupported source type');
        text(
            body.content,
            ['image', 'voice', 'pdf'].includes(body.type)
                ? 22 * 1024 * 1024
                : 2000000,
        );
        if (
            ['image', 'voice', 'pdf'].includes(body.type) &&
            !/^[A-Za-z0-9+/]+={0,2}$/.test(body.content)
        )
            throw new CreditError(400, 'Invalid attachment');
        if (['website', 'youtube'].includes(body.type)) {
            let url;
            try {
                url = new URL(body.content);
            } catch {
                throw new CreditError(400, 'Enter a valid website URL');
            }
            if (
                !['http:', 'https:'].includes(url.protocol) ||
                url.username ||
                url.password
            )
                throw new CreditError(400, 'Enter a valid website URL');
        }
    } else if (endpoint === '/reply') text(body.message);
    else if (endpoint === '/followup') {
        text(body.context);
        text(body.question, 20000);
    } else if (endpoint === '/sentiment') text(body.message ?? body.text);
    else text(body.text);
    for (const field of [
        'language',
        'targetLanguage',
        'tone',
        'format',
        'style',
        'mode',
        'noteLength',
        'length',
    ]) {
        if (
            body[field] !== undefined &&
            (typeof body[field] !== 'string' || body[field].length > 200)
        )
            throw new CreditError(400, `Invalid ${field}`);
    }
    if (
        body.instruction !== undefined &&
        (typeof body.instruction !== 'string' ||
            body.instruction.length > 20000)
    )
        throw new CreditError(400, 'Instructions are too long');
}
function validResult(endpoint, value) {
    if (Buffer.byteLength(JSON.stringify(value ?? null)) > 2 * 1024 * 1024)
        return false;
    const text = (x) =>
        typeof x === 'string' && !!x.trim() && x.length <= 2000000;
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    if (endpoint === '/reply')
        return (
            Array.isArray(value.replies) &&
            value.replies.length > 0 &&
            value.replies.length <= 30 &&
            value.replies.every(text)
        );
    if (endpoint === '/sentiment') return text(value.sentiment || value.type);
    return text(
        value[
            {
                '/notes': 'notes',
                '/followup': 'response',
                '/polish': 'polishedText',
                '/translate': 'translatedText',
            }[endpoint]
        ],
    );
}
function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object')
        return Object.fromEntries(
            Object.keys(value)
                .sort()
                .filter((k) => k !== 'isPro')
                .map((k) => [k, stable(value[k])]),
        );
    return value;
}

function createGeneration({
    User,
    GenerationRequest,
    Subscription,
    credits,
    getAppConfig,
    entitlement,
    now = () => new Date(),
    leaseMs = 180000,
}) {
    const key = (code, id) =>
        createHash('sha256').update(`${code}:${id}`).digest('hex');
    const transaction = async (work) => {
        const session = await User.db.startSession();
        try {
            return await session.withTransaction(() => work(session));
        } finally {
            await session.endSession();
        }
    };
    async function authenticate(header) {
        if (typeof header !== 'string' || !header.startsWith('Bearer '))
            throw new CreditError(
                426,
                'Update AI Notes to continue using AI. This version requires secure credit charging.',
            );
        let code;
        try {
            code = recoveryCode(header.slice(7));
            await credits.byCode(code);
        } catch (error) {
            if (![400, 404].includes(error.status))
                throw new CreditError(
                    503,
                    'Your AI account could not be verified. Please try again.',
                );
            throw new CreditError(
                401,
                'Reconnect or recover your AI Notes account',
            );
        }
        return code;
    }
    async function finish(id, status, result) {
        return transaction(async (session) => {
            const record = await GenerationRequest.findById(id)
                .session(session)
                .lean();
            if (!record) throw new CreditError(404, 'AI request was not found');
            if (record.state !== 'pending') return record;
            if (record.leaseUntil <= now() && status < 400) {
                status = 504;
                result = {
                    error: 'The AI request expired. Your credit was returned; please try again.',
                };
            }
            if (status >= 400) {
                const held = record.reservation;
                if (held.pro) {
                    await (held.subscriptionId ? Subscription : User).updateOne(
                        {
                            ...(held.subscriptionId ? { _id: held.subscriptionId } : { recoveryCode: record.recoveryCode }),
                            lastRequestReset: new Date(held.day),
                            dailyRequestCount: { $gt: 0 },
                        },
                        { $inc: { dailyRequestCount: -1 } },
                        { session },
                    );
                } else {
                    await User.updateOne(
                        { recoveryCode: record.recoveryCode },
                        {
                            $inc: {
                                [held.field]: held.free,
                                adCredits: held.ad,
                                credits: held.paid,
                            },
                        },
                        { session },
                    );
                }
            }
            return GenerationRequest.findOneAndUpdate(
                { _id: id, state: 'pending' },
                {
                    $set: {
                        state: status >= 400 ? 'failed' : 'succeeded',
                        result,
                        httpStatus: status,
                        expiresAt: new Date(now().getTime() + 86400000),
                    },
                },
                { returnDocument: 'after', session },
            ).lean();
        });
    }
    async function recoverExpired(code) {
        await GenerationRequest.updateMany(
            {
                state: { $ne: 'pending' },
                expiresAt: { $lte: now() },
                result: { $exists: true },
            },
            { $unset: { result: 1, expiresAt: 1 } },
        );
        const records = await GenerationRequest.find({
            state: 'pending',
            leaseUntil: { $lte: now() },
            ...(code ? { recoveryCode: code } : {}),
        })
            .limit(100)
            .lean();
        for (const record of records)
            await finish(record._id, 504, {
                error: 'The AI request expired. Your credit was returned; please try again.',
            });
    }
    async function begin(code, requestId, endpoint, body) {
        if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId))
            throw new CreditError(400, 'A unique AI request ID is required');
        validateInput(endpoint, body);
        const id = key(code, requestId);
        const bodyHash = createHash('sha256')
            .update(JSON.stringify(stable({ endpoint, body })))
            .digest('hex');
        await recoverExpired(code);
        const check = (record) => {
            if (record.bodyHash !== bodyHash || record.endpoint !== endpoint)
                throw new CreditError(
                    409,
                    'This request ID belongs to different content',
                );
            if (record.state === 'pending')
                throw new CreditError(
                    409,
                    'This AI request is still running. Please wait.',
                    { requestId },
                );
            return { record, cached: true };
        };
        const existing = await GenerationRequest.findById(id).lean();
        if (existing) return check(existing);
        await credits.balance(code); // Initialize any legacy allowance once before reserving.
        const config = await getAppConfig();
        const rules = policy(config);
        const membership = await entitlement(await credits.byCode(code));
        try {
            return await transaction(async (session) => {
                const duplicate = await GenerationRequest.findById(id)
                    .session(session)
                    .lean();
                if (duplicate) return check(duplicate);
                const user = await User.findOne({ recoveryCode: code })
                    .session(session)
                    .lean();
                if (!user)
                    throw new CreditError(401, 'Reconnect your AI account');
                const timestamp = now();
                let pro = membership.isPro === true;
                let quota = user;
                let quotaId = membership.quotaId;
                if (user.appleSubscriptionIds?.length) {
                    if (!Subscription)
                        throw new CreditError(503, 'Your subscription could not be checked. Please try again.');
                    // A restore, renewal or expiration can occur after the earlier
                    // provider lookup. Reserve against the current shared record.
                    const records = await Subscription.find({
                        _id: { $in: user.appleSubscriptionIds },
                    }).sort({ expiresAt: -1 }).session(session).lean();
                    const active = records.find(record =>
                        !record.revokedAt && !record.isUpgraded &&
                        Math.max(
                            new Date(record.expiresAt || 0).getTime(),
                            new Date(record.graceExpiresAt || 0).getTime(),
                        ) > timestamp.getTime(),
                    );
                    pro = !!active;
                    quota = active || records[0] || user;
                    quotaId = active?._id;
                } else if (pro && quotaId) {
                    // This wallet was unlinked while the provider lookup ran.
                    pro = false;
                    quotaId = undefined;
                }
                const usage = subscriptionUsage(quota, config, timestamp);
                const { billingMode } = body;
                let reservation;
                if (pro && usage.subscriberDailyRemaining > 0) {
                    const day = new Date(timestamp);
                    day.setUTCHours(0, 0, 0, 0);
                    const { subscriberDailyUsage: count, subscriberDailyLimit: limit } = usage;
                    const previous = quota.lastRequestReset && new Date(quota.lastRequestReset);
                    const sameDay = previous && previous >= day && previous < new Date(usage.subscriberResetAt);
                    const reset = sameDay ? previous : timestamp;
                    await (quotaId ? Subscription : User).updateOne(
                        { _id: quota._id },
                        {
                            $set: {
                                dailyRequestCount: count + 1,
                                lastRequestReset: reset,
                            },
                        },
                        { session },
                    );
                    reservation = {
                        pro: true,
                        ...(quotaId ? { subscriptionId: quotaId } : {}),
                        day: reset.toISOString(),
                        limit,
                    };
                } else {
                    const current = balance(user, rules);
                    const selectedBalance = billingMode === 'free' ? current.freeCreditsRemaining : current.credits;
                    if (pro && (!billingMode || selectedBalance < 1))
                        throw new CreditError(
                            429,
                            'You’ve used today’s Pro allowance. Wait for it to reset or choose a credit for this request.',
                            {
                                code: 'SUBSCRIPTION_DAILY_LIMIT',
                                ...usage,
                                freeCreditsAvailable: current.freeCreditsRemaining,
                                freeCreditPolicy: current.freeCreditPolicy,
                                purchasedCreditsAvailable: current.credits,
                            },
                        );
                    if (billingMode && selectedBalance < 1)
                        throw new CreditError(
                            402,
                            billingMode === 'free' ? 'No free credits remain.' : 'No purchased credits remain.',
                        );
                    if (current.totalAvailable < 1)
                        throw new CreditError(
                            402,
                            membership.sandbox
                                ? 'This Apple sandbox subscription has no test allowance enabled, and your credit balance is zero.'
                                : 'No AI credits remain. Recover an existing account or purchase more credits.',
                            membership.sandbox ? { code: 'SANDBOX_PRO_ALLOWANCE_DISABLED' } : undefined,
                        );
                    const free = billingMode === 'purchased' ? 0 : Math.min(current.freeCreditsRemaining, 1);
                    const ad = billingMode ? 0 : Math.min(current.adCredits, 1 - free);
                    const paid = 1 - free - ad;
                    await User.updateOne(
                        { _id: user._id },
                        {
                            $inc: {
                                [rules.field]: -free,
                                adCredits: -ad,
                                credits: -paid,
                            },
                        },
                        { session },
                    );
                    reservation = {
                        pro: false,
                        field: rules.field,
                        free,
                        ad,
                        paid,
                    };
                }
                const [record] = await GenerationRequest.create(
                    [
                        {
                            _id: id,
                            recoveryCode: code,
                            requestId,
                            endpoint,
                            bodyHash,
                            state: 'pending',
                            reservation: { ...reservation, membershipPro: pro },
                            leaseUntil: new Date(timestamp.getTime() + leaseMs),
                            expiresAt: new Date(timestamp.getTime() + 86400000),
                        },
                    ],
                    { session },
                );
                return { record: record.toObject(), cached: false };
            });
        } catch (error) {
            if (error.code === 11000) {
                const duplicate = await GenerationRequest.findById(id).lean();
                if (duplicate) return check(duplicate);
            }
            throw error;
        }
    }
    async function response(record) {
        if (!record.result)
            throw new CreditError(
                410,
                'This request completed earlier, but its saved result expired. No additional credit was charged. Start a new generation if you need another result.',
            );
        const current = await credits.balance(record.recoveryCode);
        const user = await credits.byCode(record.recoveryCode);
        return {
            ...record.result,
            billing: {
                version: 2,
                requestId: record.requestId,
                charged: record.state === 'succeeded',
                creditCost: record.reservation.pro
                    ? 0
                    : record.state === 'succeeded'
                      ? 1
                      : 0,
                hasProSubscription: record.reservation.membershipPro ?? record.reservation.pro,
                creditBalance: current,
                ...Object.fromEntries(Object.entries(current).filter(([key]) => key.startsWith('subscriber') || key === 'serverTime')),
            },
        };
    }
    function middleware(req, res, next) {
        const endpoint = req.path.toLowerCase().replace(/\/+$/, '');
        if (
            req.method !== 'POST' ||
            (!PATHS.has(endpoint) && endpoint !== '/notes/stream')
        )
            return next();
        const send = res.json.bind(res);
        let timer;
        const abort = new AbortController();
        let finishing = false;
        const complete = async (status, value, id) => {
            if (finishing) return;
            finishing = true;
            if (status >= 400) abort.abort();
            clearTimeout(timer);
            try {
                const record = await finish(id, status, value);
                const body = await response(record);
                if (!res.destroyed && !res.writableEnded)
                    res.status(record.httpStatus);
                if (!res.destroyed && !res.writableEnded) send(body);
            } catch (error) {
                if (!res.destroyed && !res.writableEnded) {
                    res.status(503);
                    send({
                        error: 'Your AI request is being reconciled. Retry with the same request ID to check its result.',
                    });
                }
            }
        };
        (async () => {
            if (endpoint === '/notes/stream')
                throw new CreditError(
                    410,
                    'Use the authenticated notes endpoint in the latest AI Notes app',
                );
            const config = await getAppConfig();
            // A staged deployment must continue serving installed legacy mobile
            // builds until the operator deliberately enables the strict cutover.
            if (
                config.generationBillingRequired === false &&
                !req.headers.authorization
            )
                return next();
            const code = await authenticate(req.headers.authorization);
            const { record, cached } = await begin(
                code,
                req.headers['idempotency-key'],
                endpoint,
                req.body,
            );
            if (cached) {
                res.status(record.httpStatus);
                return send(await response(record));
            }
            req.body.isPro = record.reservation.membershipPro ?? record.reservation.pro;
            if (endpoint === '/sentiment')
                req.body.message = req.body.message ?? req.body.text;
            res.json = (value) => {
                let status = res.statusCode;
                if (status < 400 && !validResult(endpoint, value)) {
                    status = 502;
                    value = {
                        error: 'The AI server returned an empty or invalid result. Your credit was returned.',
                    };
                }
                void complete(status, value, record._id);
                return res;
            };
            timer = setTimeout(
                () =>
                    void complete(
                        504,
                        {
                            error: 'The AI request timed out. Your credit was returned.',
                        },
                        record._id,
                    ),
                leaseMs,
            );
            timer.unref?.();
            context.run({ signal: abort.signal }, () => next());
        })().catch((error) => {
            res.status(error.status || 503);
            send({
                error: error.status
                    ? error.message
                    : 'AI charging is temporarily unavailable. Please try again.',
                ...(error.details || {}),
            });
        });
    }
    return {
        authenticate,
        begin,
        finish,
        response,
        recoverExpired,
        middleware,
    };
}

module.exports = { createGeneration, validateInput, validResult };
