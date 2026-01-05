const axios = require('axios');

const fetchWebsiteContent = async (url) => {
    // Try Google Cache
    const cacheUrl = `http://webcache.googleusercontent.com/search?q=cache:${url}`;
    console.log(`[DEBUG] Fetching via Google Cache: ${cacheUrl}`);
    try {
        const { data } = await axios.get(cacheUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });

        const cheerio = require('cheerio');
        const $ = cheerio.load(data);
        // Remove scripts/styles
        $('script').remove();
        $('style').remove();

        const text = $('body').text().trim().substring(0, 500);
        console.log('[DEBUG] Extracted Text:', text);
    } catch (error) {
        console.error(`[DEBUG] Failed: ${error.message}`);
        if (error.response) {
            console.error('[DEBUG] Status:', error.response.status);
        }
    }
};

// Test with a standard Medium article
const TEST_URL = 'https://medium.com/@netflixtechblog/ready-set-scale-cbb17b62feec';

fetchWebsiteContent(TEST_URL);
