const axios = require('axios');
const cheerio = require('cheerio');

const fetchManualTranscript = async (videoId) => {
    console.log(`[DEBUG] Fetching Manual Transcript for: ${videoId}`);
    try {
        const response = await axios.get(`https://www.youtube.com/watch?v=${videoId}`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
            }
        });

        const data = response.data;
        const cookies = response.headers['set-cookie'];

        if (data.includes('"captionTracks":')) {
            console.log('[DEBUG] "captionTracks" FOUND');
        } else {
            console.log('[DEBUG] "captionTracks" NOT FOUND');
            return null;
        }

        const regex = /"captionTracks":(\[.*?\])/;
        const match = regex.exec(data);
        if (!match) return null;

        const tracks = JSON.parse(match[1]);
        const track = tracks.find(t => t.languageCode === 'en') || tracks[0];

        if (!track) return null;
        console.log(`[DEBUG] Selected track: ${track.languageCode}`);

        // Prepare headers with cookies
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9',
        };

        if (cookies) {
            headers['Cookie'] = cookies.join('; ');
            console.log('[DEBUG] Passing cookies to XML request');
        }

        const { data: transcriptXml } = await axios.get(track.baseUrl, { headers });
        console.log('[DEBUG] Raw XML Length:', transcriptXml ? transcriptXml.length : 0);

        if (!transcriptXml) return null;

        const $ = cheerio.load(transcriptXml, { xmlMode: true });

        let text = '';
        $('text').each((i, el) => {
            text += $(el).text() + ' ';
        });

        const finalText = text.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim();
        console.log(`[DEBUG] Extracted Text Length: ${finalText.length}`);
        return finalText;

    } catch (error) {
        console.error('[DEBUG] Manual scraping failed:', error.message);
        return null;
    }
};

const runTests = async () => {
    console.log('--- TEST 1: User Video (Inception Trailer) ---');
    await fetchManualTranscript('YoHD9XEInc0');
};

runTests();
