// Boot the real production application against the test-only MongoDB URI.
const mongoose = require('mongoose');
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
