const { createHash } = require('node:crypto');

// Only successful intermediate extraction results live here, never generated notes.
// Scope and processing configuration are part of the identity, alongside the actual bytes.
function attachmentKey(scope, settings, bytes) {
    if (typeof scope !== 'string' || !scope) return null;
    return createHash('sha256').update(JSON.stringify([scope, settings])).update('\0').update(bytes).digest('hex');
}

function createAttachmentCache({ ttlMs = 600000, maxEntries = 32, maxBytes = 8 * 1024 * 1024,
    maxEntryBytes = 2 * 1024 * 1024, maxPending = 8, now = Date.now } = {}) {
    const values = new Map(), pending = new Map();
    let bytes = 0;
    const remove = key => {
        const entry = values.get(key);
        if (entry) bytes -= entry.bytes;
        values.delete(key);
    };
    const prune = () => {
        for (const [key, entry] of values) if (entry.until <= now()) remove(key);
    };
    const cleanup = setInterval(prune, Math.min(ttlMs, 60000));
    cleanup.unref?.();
    const get = key => {
        prune();
        const entry = key && values.get(key);
        if (!entry) return undefined;
        values.delete(key); values.set(key, entry);
        return structuredClone(entry.value);
    };
    const set = (key, value) => {
        if (!key || value === undefined) return;
        const size = Buffer.byteLength(JSON.stringify(value));
        if (size > maxEntryBytes || size > maxBytes) return;
        prune(); remove(key);
        values.set(key, { value: structuredClone(value), bytes: size, until: now() + ttlMs }); bytes += size;
        while (values.size > maxEntries || bytes > maxBytes) remove(values.keys().next().value);
    };
    const wait = (promise, signal) => new Promise((resolve, reject) => {
        const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason || new DOMException('Aborted', 'AbortError')); };
        if (signal?.aborted) return abort();
        signal?.addEventListener('abort', abort, { once: true });
        promise.then(value => { signal?.removeEventListener('abort', abort); resolve(structuredClone(value)); },
            error => { signal?.removeEventListener('abort', abort); reject(error); });
    });
    return {
        get, set, delete: remove,
        async run(key, work, signal) {
            signal?.throwIfAborted();
            const cached = get(key);
            if (cached !== undefined) return cached;
            if (!key || (!pending.has(key) && pending.size >= maxPending)) return work(signal);
            let entry = pending.get(key);
            if (!entry) {
                entry = { controller: new AbortController(), users: 0 };
                entry.promise = Promise.resolve().then(() => {
                    entry.controller.signal.throwIfAborted();
                    return work(entry.controller.signal);
                }).then(value => {
                    entry.controller.signal.throwIfAborted();
                    if (!entry.controller.signal.aborted && pending.get(key) === entry) set(key, value);
                    return value;
                }).finally(() => { if (pending.get(key) === entry) pending.delete(key); });
                // Every consumer may cancel before the shared upstream call settles.
                entry.promise.catch(() => {});
                pending.set(key, entry);
            }
            entry.users++;
            try { return await wait(entry.promise, signal); }
            finally {
                entry.users--;
                if (!entry.users && pending.get(key) === entry) {
                    pending.delete(key); entry.controller.abort();
                }
            }
        },
        dispose() {
            clearInterval(cleanup);
            for (const entry of pending.values()) entry.controller.abort();
            pending.clear(); values.clear(); bytes = 0;
        },
    };
}
module.exports = { attachmentKey, createAttachmentCache };
