const { Router, json } = require('express');
const { rateLimit } = require('express-rate-limit');
const { createCipheriv, createDecipheriv, createHash, randomBytes } = require('node:crypto');

const zohoRegions = {
    us: 'https://accounts.zoho.com', eu: 'https://accounts.zoho.eu',
    in: 'https://accounts.zoho.in', au: 'https://accounts.zoho.com.au',
    jp: 'https://accounts.zoho.jp', ca: 'https://accounts.zohocloud.ca',
};
const digest = value => createHash('sha256').update(value).digest('base64url');
const challengePattern = /^[a-zA-Z0-9_-]{43}$/;
const availableProviders = ['microsoft', 'zoho', 'jira'];

function createWorkplaceOAuth({ env = process.env, fetchImpl = fetch } = {}) {
    const router = Router();
    const encryptionKey = /^[a-f0-9]{64}$/i.test(env.WORKPLACE_OAUTH_KEY || '')
        ? Buffer.from(env.WORKPLACE_OAUTH_KEY, 'hex') : null;
    const redirect = (() => {
        try {
            const url = new URL(env.WORKPLACE_OAUTH_CALLBACK);
            if (url.protocol === 'https:' && !url.username && !url.password &&
                !url.search && !url.hash && url.pathname === '/api/workplace-oauth/callback')
                return url.href;
        } catch {
            // The route stays unavailable until its registered callback is configured.
        }
        return null;
    })();
    const failure = (status, message) => Object.assign(new Error(message), { status });
    const seal = (purpose, data) => {
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
        cipher.setAAD(Buffer.from(purpose));
        const encrypted = Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final()]);
        return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
    };
    const unseal = (purpose, value) => {
        try {
            if (!encryptionKey || typeof value !== 'string' || value.length > 16000) throw new Error();
            const encoded = Buffer.from(value, 'base64url');
            const decipher = createDecipheriv('aes-256-gcm', encryptionKey, encoded.subarray(0, 12));
            decipher.setAAD(Buffer.from(purpose));
            decipher.setAuthTag(encoded.subarray(12, 28));
            return JSON.parse(Buffer.concat([decipher.update(encoded.subarray(28)), decipher.final()]));
        } catch {
            throw failure(400, 'This connection session is invalid. Start again.');
        }
    };
    function provider(kind, region, commentAccess = false) {
        if (!availableProviders.includes(kind) || (kind === 'zoho' && (typeof region !== 'string' || !Object.hasOwn(zohoRegions, region))))
            throw failure(400, 'Choose a supported workplace provider and region.');
        const prefix = 'WORKPLACE_' + kind.toUpperCase();
        const clientId = env[prefix + '_CLIENT_ID'];
        const clientSecret = env[prefix + '_CLIENT_SECRET_' + String(region).toUpperCase()] ||
            env[prefix + '_CLIENT_SECRET'];
        if (!encryptionKey || !redirect || !clientId || !clientSecret)
            throw failure(503, 'Browser sign-in for this provider is not configured yet.');
        const microsoft = 'https://login.microsoftonline.com/common/oauth2/v2.0';
        const zoho = zohoRegions[region];
        const settings = {
            microsoft: { auth: microsoft + '/authorize', token: microsoft + '/token',
                scope: 'offline_access https://graph.microsoft.com/Tasks.Read', pkce: true },
            zoho: { auth: zoho + '/oauth/v2/auth', token: zoho + '/oauth/v2/token',
                scope: 'ZohoProjects.portals.READ,ZohoProjects.projects.READ,ZohoProjects.tasks.READ' +
                    (commentAccess ? ',ZohoProjects.tasks.CREATE' : ''),
                authorize: { access_type: 'offline', prompt: 'consent' }, pkce: true },
            jira: { auth: 'https://auth.atlassian.com/authorize', token: 'https://auth.atlassian.com/oauth/token',
                scope: 'read:jira-work offline_access' + (commentAccess ? ' write:jira-work' : ''),
                authorize: { audience: 'api.atlassian.com', prompt: 'consent' }, json: true },
        }[kind];
        return { ...settings, clientId, clientSecret };
    }

    async function tokens(kind, region, parameters, oldRefresh) {
        const settings = provider(kind, region);
        const body = { client_id: settings.clientId, client_secret: settings.clientSecret, ...parameters };
        const response = await fetchImpl(settings.token, {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12000),
            headers: { 'Content-Type': settings.json ? 'application/json' : 'application/x-www-form-urlencoded' },
            body: settings.json ? JSON.stringify(body) : new URLSearchParams(body),
        }).catch(() => null);
        if (!response) throw failure(502, 'The provider could not be reached. Try again.');
        const result = await response.json().catch(() => null);
        if (!response.ok || typeof result?.access_token !== 'string' || !result.access_token) {
            if (['invalid_grant', 'invalid_code', 'invalid_token'].includes(result?.error))
                throw failure(401, 'This provider authorization expired. Connect the account again.');
            throw failure(502, 'The provider did not authorize this connection. Check the app registration and permissions.');
        }
        const refresh = result.refresh_token || oldRefresh;
        const seconds = Number(result.expires_in ?? result.expires_in_sec);
        if (typeof refresh !== 'string' || !refresh || !Number.isFinite(seconds) || seconds < 1)
            throw failure(502, 'The provider did not return a renewable connection. Connect the account again.');
        return {
            kind, region, token: result.access_token, expiresAt: Date.now() + seconds * 1000,
            renewal: seal('renewal', { kind, region, refresh }),
        };
    }
    function stateFrom(value) {
        const state = unseal('state', value);
        if (!Number.isFinite(state.expiresAt) || state.expiresAt <= Date.now()) throw failure(400, 'This sign-in expired. Start again.');
        return state;
    }
    const endpoint = (handler) => async (req, res) => {
        res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
        try { await handler(req, res); }
        catch (error) {
            res.status(error.status || 500).json({ error: error.status ? error.message : 'Workplace sign-in could not be completed.' });
        }
    };
    router.use(rateLimit({ windowMs: 60000, limit: 30, standardHeaders: true, legacyHeaders: false }));
    router.use(json({ limit: '32kb' }));
    router.use((error, _req, res, next) => {
        if (!['entity.too.large', 'entity.parse.failed'].includes(error.type)) return next(error);
        res.set('Cache-Control', 'no-store').status(error.status).json({ error: 'Invalid workplace sign-in request.' });
    });
    router.post('/start', endpoint(async (req, res) => {
        const { kind, challenge, commentAccess } = req.body || {};
        const region = kind === 'zoho' ? req.body.region : '';
        if (typeof challenge !== 'string' || !challengePattern.test(challenge)) throw failure(400, 'Start sign-in from AI Notes.');
        const settings = provider(kind, region, commentAccess === true);
        const state = seal('state', { kind, challenge, region, expiresAt: Date.now() + 10 * 60000 });
        const url = new URL(settings.auth);
        url.search = new URLSearchParams({
            client_id: settings.clientId, redirect_uri: redirect, response_type: 'code',
            scope: settings.scope, state, ...settings.authorize,
            ...(settings.pkce && { code_challenge: challenge, code_challenge_method: 'S256' }),
        });
        res.json({ url: url.href, state });
    }));
    router.get('/callback', endpoint(async (req, res) => {
        const state = stateFrom(req.query.state);
        const target = new URL('ainotes-desktop://workplace-oauth');
        target.searchParams.set('state', req.query.state);
        if (typeof req.query.code === 'string' && req.query.code && req.query.code.length <= 2048)
            target.searchParams.set('code', seal('callback', {
                stateHash: digest(req.query.state), code: req.query.code,
                expiresAt: Math.min(state.expiresAt, Date.now() + 60_000),
            }));
        else target.searchParams.set('error', 'denied');
        res.redirect(303, target.href);
    }));
    router.post('/exchange', endpoint(async (req, res) => {
        const { state, code, verifier } = req.body || {};
        const pending = stateFrom(state);
        if (typeof verifier !== 'string' || !challengePattern.test(verifier) || digest(verifier) !== pending.challenge ||
            typeof code !== 'string' || !code || code.length > 5000)
            throw failure(400, 'This sign-in did not match the one opened by AI Notes.');
        const callback = unseal('callback', code);
        if (callback.stateHash !== digest(state) || callback.expiresAt <= Date.now())
            throw failure(400, 'This sign-in callback is invalid or expired. Start again.');
        const { pkce } = provider(pending.kind, pending.region);
        res.json(await tokens(pending.kind, pending.region, {
            grant_type: 'authorization_code', code: callback.code, redirect_uri: redirect,
            ...(pkce && { code_verifier: verifier }),
        }));
    }));
    router.post('/refresh', endpoint(async (req, res) => {
        const { kind, region, refresh } = unseal('renewal', req.body?.renewal);
        res.json(await tokens(kind, region, { grant_type: 'refresh_token', refresh_token: refresh }, refresh));
    }));
    return router;
}

module.exports = { createWorkplaceOAuth };
