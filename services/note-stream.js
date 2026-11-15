// Transport only: the existing reservation/commit path owns charging and final receipts.
function createNoteStream(res, requestId) {
    res.status(200);
    res.set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    let ended = false;
    const write = value => {
        if (!ended && !res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(value)}\n\n`);
    };
    write({ type: 'start', version: 1, requestId });
    const heartbeat = setInterval(() => {
        if (!ended && !res.destroyed && !res.writableEnded) res.write(': keep-alive\n\n');
    }, 15000);
    heartbeat.unref?.();
    const cleanup = () => clearInterval(heartbeat);
    res.once('close', cleanup);
    return {
        delta(text) { if (typeof text === 'string' && text) write({ type: 'delta', text }); },
        finish(status, body) {
            if (ended) return;
            cleanup();
            write({ type: 'complete', status, body });
            ended = true;
            if (!res.destroyed && !res.writableEnded) res.end();
        },
    };
}
module.exports = { createNoteStream };
