const assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto');
const test = require('node:test');
const express = require('express');
const { createWorkplaceOAuth } = require('../routes/workplace-oauth');

const callback = 'https://api.example.test/api/workplace-oauth/callback';
const providers = {
    jira: ['https://auth.atlassian.com/oauth/token', 'read:jira-work offline_access', 'write:jira-work'],
    microsoft: ['https://login.microsoftonline.com/common/oauth2/v2.0/token', 'offline_access https://graph.microsoft.com/Tasks.Read'],
    zoho: ['https://accounts.zoho.in/oauth/v2/token', 'ZohoProjects.portals.READ,ZohoProjects.projects.READ,ZohoProjects.tasks.READ', 'ZohoProjects.tasks.CREATE'],
};
const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');

async function serverFor(t, options) {
    const app = express();
    app.use('/api/workplace-oauth', createWorkplaceOAuth(options));
    const server = await new Promise((resolve, reject) => {
        const listener = app.listen(0, '127.0.0.1').once('listening', () => resolve(listener)).once('error', reject);
    });
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = 'http://127.0.0.1:' + server.address().port + '/api/workplace-oauth';
    return (url, body) => fetch(base + url, {
        redirect: 'manual',
        ...(body === undefined ? {} : {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        }),
    });
}

for (const [kind, [tokenURL, readScope, writeScope]] of Object.entries(providers)) {
    test(kind + ' authorization preserves the provider contract, optional scopes, and refresh', async t => {
        const prefix = 'WORKPLACE_' + kind.toUpperCase();
        const region = kind === 'zoho' ? 'in' : '';
        const calls = [];
        const request = await serverFor(t, {
            env: {
                WORKPLACE_OAUTH_KEY: randomBytes(32).toString('hex'),
                WORKPLACE_OAUTH_CALLBACK: callback,
                [prefix + '_CLIENT_ID']: 'sample-id',
                [prefix + '_CLIENT_SECRET']: 'sample-secret',
            },
            fetchImpl: async (url, options) => {
                assert.equal(url, tokenURL);
                assert.equal(options.redirect, 'error');
                const body = typeof options.body === 'string' ? JSON.parse(options.body) : Object.fromEntries(options.body);
                calls.push(body);
                return Response.json({
                    access_token: 'access-' + calls.length,
                    refresh_token: (kind === 'jira' || calls.length === 1) ? 'refresh-' + calls.length : undefined,
                    expires_in: 3600,
                });
            },
        });
        const start = async commentAccess => {
            const response = await request('/start', { kind, region, challenge, commentAccess });
            assert.equal(response.status, 200);
            assert.equal(response.headers.get('cache-control'), 'no-store');
            return response.json();
        };
        const { url, state } = await start(false);
        const consent = new URL(url);
        assert.equal(consent.hostname, new URL(tokenURL).hostname);
        assert.equal(consent.searchParams.get('scope'), readScope);
        assert.equal(consent.searchParams.get('redirect_uri'), callback);
        assert.equal(consent.searchParams.get('state'), state);
        assert.equal(consent.searchParams.get('code_challenge'), kind === 'jira' ? null : challenge);
        assert.equal(consent.searchParams.get('code_challenge_method'), kind === 'jira' ? null : 'S256');
        const other = await start(true);
        if (writeScope) assert.ok(new URL(other.url).searchParams.get('scope').includes(writeScope));
        else assert.equal(new URL(other.url).searchParams.get('scope'), readScope);
        const denial = await request('/callback?' + new URLSearchParams({ state, error: 'access_denied' }));
        assert.equal(denial.status, 303);
        assert.equal(new URL(denial.headers.get('location')).searchParams.get('error'), 'denied');

        const redirect = await request('/callback?' + new URLSearchParams({ state, code: 'provider-code' }));
        assert.equal(redirect.status, 303);
        const target = new URL(redirect.headers.get('location'));
        assert.equal(target.protocol, 'ainotes-desktop:');
        assert.equal(target.hostname, 'workplace-oauth');
        assert.equal(target.searchParams.get('state'), state);
        const code = target.searchParams.get('code');
        assert.ok(code);
        assert.doesNotMatch(code, /provider-code/);
        const exchange = values => request('/exchange', { state, code, verifier, ...values });
        assert.equal((await exchange({ verifier: challenge })).status, 400);
        assert.equal((await exchange({ state: other.state })).status, 400);
        assert.equal((await exchange({ code: 'provider-code' })).status, 400);
        assert.equal(calls.length, 0);
        const response = await exchange();
        assert.equal(response.status, 200);
        const connected = await response.json();
        assert.equal(connected.token, 'access-1');
        assert.equal(connected.kind, kind);
        assert.equal(connected.region, region);
        assert.ok(connected.expiresAt > Date.now());
        assert.doesNotMatch(JSON.stringify(connected), /refresh-1|sample-secret/);
        assert.equal(calls[0].code, 'provider-code');
        assert.equal(calls[0].code_verifier, kind === 'jira' ? undefined : verifier);
        assert.equal(calls[0].client_secret, 'sample-secret');

        assert.equal((await request('/refresh', { renewal: state })).status, 400);
        const refreshed = await request('/refresh', { renewal: connected.renewal });
        assert.equal(refreshed.status, 200);
        const refreshedBody = await refreshed.json();
        assert.equal(refreshedBody.token, 'access-2');
        assert.doesNotMatch(JSON.stringify(refreshedBody), /refresh-2|sample-secret/);
        assert.equal(calls[1].refresh_token, 'refresh-1');
        assert.equal((await request('/refresh', { renewal: refreshedBody.renewal })).status, 200);
        assert.equal(calls[2].refresh_token, kind === 'jira' ? 'refresh-2' : 'refresh-1');
    });
}

test('an unconfigured or invalid provider never contacts an external endpoint', async t => {
    const request = await serverFor(t, { env: {}, fetchImpl: () => assert.fail('Unexpected provider call') });
    assert.equal((await request('/start', { kind: 'jira', challenge })).status, 503);
    assert.equal((await request('/start', { kind: 'zoho', region: 'constructor', challenge })).status, 400);
    assert.equal((await request('/start', { kind: 'jira', challenge: 'x' })).status, 400);
    assert.equal((await request('/start', { kind: 'jira', challenge, extra: 'x'.repeat(33000) })).status, 413);
    assert.equal((await request('/callback?state=bad&code=test')).status, 400);
});
