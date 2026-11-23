const cheerio = require('cheerio');

function createManualTranscript({ http, timeoutMs = 20000, requestTimeoutMs = 10000 }) {
    return async function manualTranscript(videoId, { signal } = {}) {
        const deadline = AbortSignal.timeout(timeoutMs);
        const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
        const options = { timeout: Math.min(requestTimeoutMs, timeoutMs), signal: combined,
            maxContentLength: 4 * 1024 * 1024 };
        try {
            combined.throwIfAborted();
            const { data } = await http.get(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, {
                ...options,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                    'Accept-Language': 'en-US,en;q=0.9',
                },
            });
            combined.throwIfAborted();
            const match = data.match(/"captionTracks":(\[.*?\])/);
            if (!match) return null;
            const tracks = JSON.parse(match[1]);
            const track = tracks.find(value => value.languageCode === 'en') || tracks[0];
            if (!track) return null;
            const { data: xml } = await http.get(track.baseUrl, options);
            combined.throwIfAborted();
            const $ = cheerio.load(xml, { xmlMode: true });
            const text = $('text').toArray().map(node => $(node).text()).join(' ');
            return text.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim();
        } catch (error) {
            // A cancelled generation must stop instead of continuing fallback work.
            if (signal?.aborted) signal.throwIfAborted();
            return null;
        }
    };
}
module.exports = { createManualTranscript };
