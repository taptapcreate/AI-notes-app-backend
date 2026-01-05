const ytdl = require('@distube/ytdl-core');
const axios = require('axios');
const cheerio = require('cheerio');

const runTest = async (videoId) => {
    console.log(`[DEBUG] ytdl-core test for: ${videoId}`);
    try {
        const info = await ytdl.getInfo(`https://www.youtube.com/watch?v=${videoId}`);
        const tracks = info.player_response.captions?.playerCaptionsTracklistRenderer?.captionTracks;

        if (!tracks || tracks.length === 0) {
            console.log('[DEBUG] No captions found via ytdl-core');
            return;
        }

        console.log(`[DEBUG] Found ${tracks.length} tracks.`);
        const track = tracks.find(t => t.languageCode === 'en') || tracks[0];
        console.log(`[DEBUG] Selected track: ${track.languageCode} - ${track.baseUrl}`);

        // ytdl-core returns the baseUrl. We still need to fetch it.
        // But ytdl-core might have handled the signature/consent in the info phase?
        // Actually, the track.baseUrl usually works if extracted from a fresh 'info' call.

        console.log('[DEBUG] Fetching XML...');
        const { data: transcriptXml } = await axios.get(track.baseUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            }
        });

        console.log('[DEBUG] Raw XML Length:', transcriptXml.length);

        const $ = cheerio.load(transcriptXml, { xmlMode: true });
        let text = '';
        $('text').each((i, el) => {
            text += $(el).text() + ' ';
        });

        const finalText = text.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim();
        console.log(`[DEBUG] Extracted Text Length: ${finalText.length}`);

    } catch (error) {
        console.error('[DEBUG] ytdl-core failed:', error.message);
    }
};

runTest('YoHD9XEInc0');
