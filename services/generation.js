const { subscriptionUsage } = require('./subscription-usage');
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
    if (body.billingMode !== undefined && body.billingMode !== 'purchased')
        throw new CreditError(400, 'Invalid billing mode');
    const text = (value, max = 2000000) => {
        if (typeof value !== 'string' || !value.trim() || value.length > max)
            throw new CreditError(400, 'Enter valid source content');
    };
    if (endpoint === '/notes') {
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
                    await User.updateOne(
                        {
                            recoveryCode: record.recoveryCode,
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
        const pro = membership.isPro === true;
        const limit = config.subscriberDailyLimit ?? 10;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000)
            throw new CreditError(
                503,
                'Subscription limits are temporarily unavailable',
            );
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
                let reservation;
                if (pro && body.billingMode !== 'purchased') {
                    const day = new Date(timestamp);
                    day.setUTCHours(0, 0, 0, 0);
                    const previous = user.lastRequestReset
                        ? new Date(user.lastRequestReset)
                        : null;
                    const sameDay = previous && previous >= day;
                    const count = sameDay ? user.dailyRequestCount || 0 : 0;
                    if (!Number.isSafeInteger(count) || count < 0)
                        throw new CreditError(
                            503,
                            'Subscription usage needs support review',
                        );
                    if (count >= limit)
                        throw new CreditError(
                            429,
                            'Your daily subscription allowance is used. You can wait for the reset or choose to use a purchased credit.',
                            { code: 'SUBSCRIPTION_DAILY_LIMIT', ...subscriptionUsage(user, config, timestamp), purchasedCreditsAvailable: user.credits || 0 },
                        );
                    const reset = sameDay ? previous : timestamp;
                    await User.updateOne(
                        { _id: user._id },
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
                        day: reset.toISOString(),
                        limit,
                    };
                } else {
                    const current = balance(user, rules);
                    if (current.totalAvailable < 1)
                        throw new CreditError(
                            402,
                            'No AI credits remain. Recover an existing account or purchase more credits.',
                        );
                    if (body.billingMode === 'purchased' && current.credits < 1)
                        throw new CreditError(402, 'No purchased credits remain. Your daily allowance will reset automatically.');
                    const free = body.billingMode === 'purchased' ? 0 : Math.min(current.freeCreditsRemaining, 1);
                    const ad = body.billingMode === 'purchased' ? 0 : Math.min(current.adCredits, 1 - free);
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
                ...subscriptionUsage(user, await getAppConfig(), now()),
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
