// Boot the real production application against the test-only MongoDB URI.
const mongoose = require('mongoose');
if (process.env.AI_NOTES_TEST_WEB === '1') {
    const axios = require('axios');
    const original = axios.get.bind(axios);
    axios.get = async (url, options) => {
        if (url === 'https://example.com/blocked') {
            throw Object.assign(new Error('Forbidden'), { response: { status: 403 } });
        }
        if (url === 'https://example.com/interstitial') {
            return { data: '<title>Just a moment...</title><p>Verify you are human to continue.</p>', headers: { 'content-type': 'text/html' } };
        }
        if (typeof url === 'string' && url.startsWith('https://api.revenuecat.com/v1/subscribers/'))
            return { data: { subscriber: { subscriptions: {} } } };
        return original(url, options);
    };
}
const { app } = require('../../server');
(async () => {
    await mongoose.connection.asPromise();
    const server = app.listen(0, '127.0.0.1', () =>
        process.send({ port: server.address().port }),
    );
    process.on('message', async (message) => {
        if (message !== 'stop') return;
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        await mongoose.disconnect();
        process.exit(0);
    });
})().catch((error) => {
    console.error(error.message);
    process.exit(1);
});
