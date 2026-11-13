const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const { MODEL, InvalidSource, createOpenRouter } = require('./services/openrouter');
const mongoose = require('mongoose');
const axios = require('axios');
const cheerio = require('cheerio');
const { YoutubeTranscript } = require('youtube-transcript');
const { Expo } = require('expo-server-sdk');
require('dotenv').config();

// Initialize Expo Push SDK
const expo = new Expo();

// Import User model
const User = require('./models/User');
const PendingPurchase = require('./models/PendingPurchase');

const app = express();
const PORT = process.env.PORT || 3000;
// Set this to the verified number of ingress proxies on the deployment.
// Never trust arbitrary forwarded headers on a directly reachable server.
if (process.env.TRUST_PROXY_HOPS !== undefined) {
    const hops = Number(process.env.TRUST_PROXY_HOPS);
    if (!Number.isInteger(hops) || hops < 0 || hops > 10) throw new Error('Invalid TRUST_PROXY_HOPS');
    app.set('trust proxy', hops);
}

// MongoDB Connection
const DB_NAME = 'ai_notes_app';

const AppConfig = require('./models/AppConfig');
const { releaseConfig } = require('./services/release-config');
const { publicMaintenance, createMaintenanceGate } = require('./services/maintenance');

const CreditRegistration = require('./models/CreditRegistration');
const PurchaseClaim = require('./models/PurchaseClaim');
const { createCredits } = require('./services/credits');
const { createPurchases } = require('./services/purchases');
const { getWelcomeCredits } = require('./services/credit-policy');
const { getSubscriberDailyLimit } = require('./services/subscription-usage');
const { createCreditRouter } = require('./routes/credits');
const { createRevenueCatHandler } = require('./routes/revenuecat');
const { createPurchaseAdminRouter } = require('./routes/purchase-admin');
const AppleSubscription = require('./models/AppleSubscription');
const GenerationRequest = require('./models/GenerationRequest');
const { createAppleSubscriptions } = require('./services/apple-subscriptions');
const appleSubscriptions = createAppleSubscriptions({ User, Subscription: AppleSubscription, GenerationRequest, getAppConfig: () => getAppConfig() });
const creditService = createCredits({ User, CreditRegistration, PurchaseClaim, getAppConfig: () => getAppConfig(),
    subscriptionUsageFor: (user, config, timestamp) => appleSubscriptions.usage(user, config, timestamp) });
const purchaseService = createPurchases({
    credits: creditService, appleSubscriptions, axios, apiKey: process.env.REVENUECAT_API_SECRET_KEY,
    allowSandbox: process.env.REVENUECAT_ALLOW_SANDBOX === 'true',
});
const { createGeneration } = require('./services/generation');
const { signal: generationSignal } = require('./services/generation-context');
const generationService = createGeneration({ User, GenerationRequest, Subscription: AppleSubscription, credits: creditService,
    getAppConfig: () => getAppConfig(), entitlement: user => purchaseService.subscriptionStatus(user) });


// Helper: Get App Config (Singleton)
const getAppConfig = async () => {
    // Preserve existing production settings. A missing database/configuration is
    // not permission to hand out a fallback allowance.
    return AppConfig.findOneAndUpdate({ key: 'master_config' }, {
        $setOnInsert: { key: 'master_config' },
    }, { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true });
};

mongoose.connect(process.env.MONGODB_URI, { dbName: DB_NAME })
    .then(() => console.log(`✅ Connected to MongoDB Atlas (${DB_NAME})`))
    .catch(err => console.error('❌ MongoDB connection error:', err));

// Middleware
app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use('/api', createMaintenanceGate({ getAppConfig }));
app.use('/api', generationService.middleware);

const { complete, transcribe } = createOpenRouter(new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPEN_ROUTER_API_KEY,
    timeout: 60000,
    maxRetries: 0,
}));

// Helper: Sleep function for delays
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Helper: Fetch Website Content
const fetchWebsiteContent = async (url) => {
    try {
        const { data, headers } = await axios.get(url, {
            timeout: 15000,
            maxContentLength: 2 * 1024 * 1024,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });
        if (typeof data !== 'string' || !/^text\/(html|plain)(?:;|$)/i.test(headers['content-type'] || ''))
            throw new Error('Unsupported page content');
        const $ = cheerio.load(data);
        if ($('meta[name="robots"]').attr('content')?.split(/[\s,]+/).includes('noai') ||
            /just a moment|access denied|verify (?:that )?you are human|attention required/i.test($('title').text()))
            throw new Error('Restricted page');

        // Remove scripts, styles, and ads
        $('script').remove();
        $('style').remove();
        $('nav').remove();
        $('footer').remove();
        $('.ads').remove();

        // Extract meaningful text
        let content = '';
        $('h1, h2, h3, p, li').each((i, el) => {
            const text = $(el).text().trim();
            if (text.length > 20) {
                content += text + '\n';
            }
        });

        if (headers['content-type'].startsWith('text/plain')) content = data.trim();
        if (!content.trim()) throw new Error('Empty page');
        return content.substring(0, 10000);
    } catch {
        throw new Error('WEB_ACCESS_BLOCKED: AI Notes couldn’t read this page. Paste the article text instead.');
    }
};

// Helper: Manual Transcript Fetch (Fallback)
const fetchManualTranscript = async (videoId) => {
    try {
        const { data } = await axios.get(`https://www.youtube.com/watch?v=${videoId}`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
            }
        });

        const regex = /"captionTracks":(\[.*?\])/;
        const match = regex.exec(data);
        if (!match) return null;

        const tracks = JSON.parse(match[1]);
        // Prefer English, fallback to first available
        const track = tracks.find(t => t.languageCode === 'en') || tracks[0];

        if (!track) return null;

        const { data: transcriptXml } = await axios.get(track.baseUrl);
        const $ = cheerio.load(transcriptXml, { xmlMode: true });

        let text = '';
        $('text').each((i, el) => {
            text += $(el).text() + ' ';
        });

        // Clean up HTML entities
        return text.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim();
    } catch (error) {
        console.error('Manual scraping failed:', error.message);
        return null;
    }
};

// Helper: Fetch YouTube Transcript
const fetchYouTubeTranscript = async (url) => {
    console.log(`[DEBUG] Fetching transcript for URL: ${url}`);
    try {
        let videoId = url;

        // Extract ID from Shorts, standard URLs, or share links
        if (url.includes('shorts/')) {
            const match = url.match(/shorts\/([a-zA-Z0-9_-]+)/);
            if (match) videoId = match[1];
        } else if (url.includes('v=')) {
            const match = url.match(/[?&]v=([a-zA-Z0-9_-]+)/);
            if (match) videoId = match[1];
        } else if (url.includes('youtu.be/')) {
            const match = url.match(/youtu\.be\/([a-zA-Z0-9_-]+)/);
            if (match) videoId = match[1];
        }

        console.log(`[DEBUG] Extracted Video ID: ${videoId}`);

        let transcript = '';
        try {
            const transcriptItems = await YoutubeTranscript.fetchTranscript(videoId);
            if (transcriptItems && transcriptItems.length > 0) {
                transcript = transcriptItems.map(item => item.text).join(' ');
            }
        } catch (libError) {
            console.log(`[DEBUG] Library failed, trying manual fallback: ${libError.message}`);
        }

        // Fallback to manual scraping if library failed
        if (!transcript || transcript.trim().length === 0) {
            console.log('[DEBUG] Trying manual fallback...');
            const manualTranscript = await fetchManualTranscript(videoId);
            if (manualTranscript) {
                transcript = manualTranscript;
            }
        }

        if (!transcript || transcript.trim().length === 0) {
            throw new Error('YOUTUBE_BLOCK: Automated access blocked by YouTube. Please copy/paste transcript manually.');
        }

        return transcript.substring(0, 15000); // Limit context window (Optimized from 25k)
    } catch (error) {
        if (error.message.includes('YOUTUBE_BLOCK')) throw error;
        throw new Error(`Failed to fetch YouTube transcript: ${error.message}`);
    }
};

// Helper: API Call with Retry Logic (Exponential Backoff)
const generateWithRetry = async (maxTokens, content, retries = 3, delay = 2000) => {
    try {
        generationSignal()?.throwIfAborted();
        return await complete(content, maxTokens, generationSignal());
    } catch (error) {
        const isRateLimit = error.message.includes('429') || error.message.includes('Too Many Requests');
        const isServiceUnavailable = error.message.includes('503') || error.message.includes('Overloaded');

        if (retries > 0 && (isRateLimit || isServiceUnavailable)) {
            console.log(`⚠️ API Busy (Rate Limit). Retrying in ${delay / 1000}s... (${retries} attempts left)`);
            await sleep(delay);
            return generateWithRetry(maxTokens, content, retries - 1, delay * 2);
        }
        throw error;
    }
};

// ==================== SHARED GUIDES ====================

// Note length instructions with token limits
const lengthGuides = {
    brief: {
        instruction: 'Provide a concise but informative summary. Aim for 5-7 useful points when the source supports them; use fewer for short material. Keep it short but ensure the main context and important details are clear.',
        maxTokens: 1200
    },
    standard: {
        instruction: 'Provide a comprehensive and well-rounded summary. Cover the main themes with sufficient explanations and important details; aim for 10-15 points only when justified by the source. Provide a good level of depth without being overly exhaustive.',
        maxTokens: 2500
    },
    detailed: {
        instruction: 'Provide a very thorough and comprehensive analysis. Develop the core insights, supporting evidence, explanations, and nuances without page-by-page recitation. Use as many points as the material warrants, without padding.',
        maxTokens: 5000 // Increased further for depth per user request
    },
};

// Tone instructions (Combined Notes + Reply)
const toneGuides = {
    professional: 'Use professional, business-appropriate language.',
    academic: 'Use formal, academic language suitable for research or study.',
    casual: 'Use relaxed, easy-to-understand language.',
    creative: 'Use engaging, descriptive, and creative language.',
    friendly: 'Be warm, approachable, and friendly.',
    flirty: 'Be playful, charming, and slightly flirty.',
    witty: 'Be clever, quick-witted, and sharp.',
    sarcastic: 'Use sarcasm and irony (but keep it light).',
    firm: 'Be firm, decisive, and authoritative.',
    humorous: 'Be funny, amusing, and lighthearted.',
    empathetic: 'Show deep understanding and empathy.',
    supportive: 'Be encouraging, uplifting, and supportive.',
    dramatic: 'Be expressive, emotional, and dramatic.',
    enthusiastic: 'Show high energy and excitement.',
    apologetic: 'Be sincere, sorry, and apologetic.',
    grateful: 'Express strong appreciation and gratitude.',
    confident: 'Sound sure, self-assured, and confident.',
};

// Format instructions (Combined Notes + Reply)
const formatGuides = {
    // Notes formats
    bullet: 'Use standard bullet points with clear hierarchy.',
    meeting: 'Format as meeting minutes: structured with Attendees, Agenda, Discussion Points, Decisions made, and Action Items.',
    study: 'Format as a study guide: Definitions, Key Concepts, Summaries, and Review Questions.',
    todo: 'Format as a To-Do list: prioritized tasks, clear checkboxes, and deadlines/timeframes if implied.',
    summary: 'Format as an executive summary: High-level overview, key findings, and strategic recommendations. Paragraph form.',
    blog: 'Format as a structured blog post skeleton: Catchy Title, Introduction, clearly headed Body Paragraphs, and Conclusion.',

    // Reply formats
    email: 'Format as a standard email with Subject line.',
    whatsapp: 'Format as a WhatsApp message: casual, use emojis, short paragraphs.',
    sms: 'Format as a text message: very short, concise, no subject line.',
    instagram: 'Format for Instagram DM: casual, trendy, use emojis.',
    dating: 'Format for a dating app message: engaging, personal, conversation starter.',
    linkedin: 'Format for LinkedIn: professional but networking-focused.',
    twitter: 'Format as a Tweet/X post: under 280 chars, use hashtags.',
    discord: 'Format for Discord: gamer/community tone, use markdown if needed.',
    slack: 'Format for Slack: professional but colloquial, clear and concise.',
    tiktok: 'Format for TikTok comment/caption: catchy, trendy, uses hashtags.',
    letter: 'Format as a formal letter: Date, Salutation, Body, Closing.',
    eli5: 'Format as an "Explain Like I\'m 5" (ELI5) summary: use very simple language, relatable analogies, and avoid technical jargon.',
    quiz: 'Generate 5 study questions or a quick quiz based on the content to help with learning and retention.',
    recipe: 'Format as a recipe: extract Ingredients (with measurements) and Step-by-Step Instructions.',
    code: 'Format as a code explanation: break down logic into simple steps, explain technical terms, and highlight efficiency.',
    social: 'Format as a catchy social media post: use hooks, emojis, and relevant hashtags. Engaging and shareable.',
    grammar: 'Focus on fixing spelling, grammar, and punctuation while maintaining the original meaning. Only improve clarity.',
};

// Style instructions (Reply specific)
const styleGuides = {
    short: 'Keep it brief and to the point.',
    detailed: 'Provide a detailed and comprehensive response.',
    polite: 'Be very polite, courteous, and respectful.',
    direct: 'Be direct, straightforward, and efficient.',
    questioning: 'Include thoughtful questions to keep the conversation going.',
    persuasive: 'Use persuasive language to convince or influence.',
    philosophical: 'Adopt a philosophical, deep, and contemplative style.',
    poetic: 'Use poetic, lyrical, and expressive language.',
    diplomatic: 'Be diplomatic, tactful, and careful with wording.',
    storytelling: 'Use a storytelling approach with narrative elements.',
    numbered: 'Format the response as a numbered list.',
};

// ==================== NOTES ENDPOINT ====================
const { appendNarration } = require('./services/walkthrough');
const { buildNotePrompt } = require('./services/note-prompts');
app.post('/api/notes', async (req, res) => {
    try {
        const { type, content, noteLength = 'standard', format = 'bullet', tone = 'professional', language = 'english', instruction: requestedInstruction = '', sourceKind, isPro = false } = req.body;
        const instruction = await appendNarration(requestedInstruction, req.body.narration, transcribe, generationSignal());

        if (!content) {
            return res.status(400).json({ error: 'Content is required' });
        }

        const lengthConfig = lengthGuides[noteLength] || lengthGuides.standard;
        const lengthInstruction = lengthConfig.instruction;
        const maxTokens = lengthConfig.maxTokens;

        const formatInstruction = formatGuides[format] || formatGuides.bullet;

        const toneInstruction = toneGuides[tone] || toneGuides.professional;

        // Language instruction
        const languageInstruction = language && language.toLowerCase() !== 'english'
            ? `IMPORTANT: Generate ALL content in ${language}. Provide the SAME level of detail and number of points as you would in English. Do NOT shorten or summarize when translating. Use natural ${language} phrasing.`
            : 'Keep the output in English.';

        const promptFor = (sourceContent = content) => buildNotePrompt({
            type, sourceKind, content: sourceContent, instruction,
            lengthInstruction, formatInstruction, toneInstruction, languageInstruction, isPro,
            url: ['website', 'youtube'].includes(type) ? content : undefined,
        });
        let result;
        switch (type) {
            case 'text':
                result = await generateWithRetry(maxTokens, promptFor());
                break;
            case 'image':
            case 'pdf':
                result = await generateWithRetry(maxTokens, [promptFor(), {
                    inlineData: { mimeType: type === 'pdf' ? 'application/pdf' : 'image/jpeg', data: content },
                }]);
                break;
            case 'voice':
                result = await generateWithRetry(maxTokens, promptFor(await transcribe(content, generationSignal())));
                break;
            case 'website':
                result = await generateWithRetry(maxTokens, promptFor(await fetchWebsiteContent(content)));
                break;
            case 'youtube':
                result = await generateWithRetry(maxTokens, promptFor(await fetchYouTubeTranscript(content)));
                break;
            default:
                return res.status(400).json({ error: 'Invalid input type' });
        }

        let notes = result.text;

        // Check if response was truncated (cut off mid-sentence)
        const finishReason = result.finishReason;

        // Truncation cleanup instead of continuation (Saves tokens/cost)
        if (finishReason === 'length') {
            console.log('Notes truncated. Trimming last incomplete sentence to save cost.');
            const lastCompleteEnd = Math.max(
                notes.lastIndexOf('. '),
                notes.lastIndexOf('.\n'),
                notes.lastIndexOf('!\n'),
                notes.lastIndexOf('?\n')
            );
            if (lastCompleteEnd > notes.length * 0.5) {
                notes = notes.substring(0, lastCompleteEnd + 1).trim();
            }
        }

        res.json({ notes });

    } catch (error) {
        if (error instanceof InvalidSource) return res.status(400).json({ error: error.message });
        if (/^(WEB_ACCESS_BLOCKED|YOUTUBE_BLOCK):/.test(error.message)) {
            return res.status(502).json({ error: error.message });
        }
        console.error('Notes generation error:', { type: req.body?.type, status: error.status, code: error.code, name: error.name });
        res.status(502).json({
            error: req.body?.type === 'pdf'
                ? 'AI Notes could not process this PDF. Try again, or choose an unlocked PDF with fewer pages.'
                : req.body?.type === 'voice'
                    ? 'AI Notes could not process this recording. Try again, or choose a shorter recording.'
                    : 'AI Notes could not generate notes right now. Please try again.',
        });
    }
});
// ==================== REPLY ENDPOINT ====================
app.post('/api/reply', async (req, res) => {
    try {
        const { message, tone, style, format, mode = 'reply', language = 'English', instruction = '', isPro = false } = req.body;

        if (!message) {
            return res.status(400).json({ error: 'Message is required' });
        }

        // Determine number of replies (PRO GETS 5, FREE GETS 3)
        const replyCount = isPro ? 5 : 3;

        // ... keys ...

        // PRO: Smarter Prompt Logic
        const proInstruction = isPro
            ? `
    🌟 **PRO MODE ACTIVE (High Intelligence Analysis)**
    - Use **Chain-of-Thought** reasoning to structure your output.
    - Go deeper than surface level: Analyze *implications*, *unspoken context*, and *strategic value*.
    - If explaining a concept, assume the user is intelligent but wants clarity (like Feynman Technique).
    - If summarizing, prioritize *synthesizing ideas* over just listing facts.
    - Use richer vocabulary and more precise terminology suitable for an expert audience.
    `
            : '';

        let prompt;

        if (mode === 'refine') {
            // STRICT REFINE MODE
            prompt = `You are an expert editor and translator. Rewrite/Refine the user's draft message.
    ${proInstruction}

USER'S DRAFT:
"""
${message}
"""

TARGET REQUIREMENTS:
• Format: ${formatGuides[format] || formatGuides.email}
• Output Language: ${language}
• USER INTENT/INSTRUCTION: ${instruction || 'None provided. Focus on polishing the draft.'}

IMPORTANT RULES:
1. Do NOT reply to the message. You must REWRITE it.
2. Keep the original meaning but change the wording/tone.
3. Write as a NATIVE speaker of ${language}. Do not use literal translations.
4. If the target language is different from input, TRANSLATE + REFINE simultaneously to sound natural.
5. Generate ${replyCount} distinct versions.
6. Each version must be COMPLETE.
7. Separate strictly with: ---REPLY---

Generate ${replyCount} refined versions now:`;

        } else if (mode === 'compose') {
            // STRICT COMPOSE MODE
            prompt = `You are an expert writer and translator. Write a message based on the user's topic/instruction.
    ${proInstruction}

USER'S TOPIC/INSTRUCTION:
"""
${message}
"""

TARGET REQUIREMENTS:
• Format: ${formatGuides[format] || formatGuides.email}
• Output Language: ${language}
• USER INTENT/INSTRUCTION: ${instruction || 'None provided. Compose a complete version based on topic.'}

IMPORTANT RULES:
1. Write a NEW message about this topic in ${language}.
2. Expand on the instruction to make it a complete message.
3. Write as a NATIVE speaker of ${language}.
4. Generate ${replyCount} distinct versions.
5. Each version must be COMPLETE.
6. Separate strictly with: ---REPLY---

Generate ${replyCount} versions now:`;

        } else {
            // STRICT REPLY MODE (Default)
            prompt = `You are an expert communication assistant. Generate a reply TO the message below.
    ${proInstruction}

RECEIVED MESSAGE:
"""
${message}
"""

REPLY REQUIREMENTS:
• Format: ${formatGuides[format] || formatGuides.email}
• Output Language: ${language}
• USER INTENT/INSTRUCTION: ${instruction || 'None provided. Generate helpful replies.'}

IMPORTANT RULES:
1. You are engaging in conversation. Reply TO what was said.
2. Answer in ${language} regardless of the input language.
3. Write as a NATIVE speaker of ${language}.
4. Don't simply rewrite the message. Answer it.
5. Generate ${replyCount} distinct options.
6. Each option must be COMPLETE.
7. Separate strictly with: ---REPLY---

Generate ${replyCount} replies now:`;
        }

        const result = await generateWithRetry(2048, prompt);
        const responseText = result.text;

        // Split the response into separate replies
        let replies = responseText.split('---REPLY---')
            .map(reply => reply.trim())
            .filter(reply => reply.length > 0);

        // If splitting didn't work well, try other patterns
        if (replies.length < replyCount) {
            replies = responseText.split(/\n\n(?=(?:Hi|Hello|Dear|Hey|Thank|I ))/i)
                .map(reply => reply.trim())
                .filter(reply => reply.length > 15);
        }

        // Clean up any remaining markers
        replies = replies.map(reply =>
            reply.replace(/^(Reply\s*\d+:?|Option\s*\d+:?|\d+\.)/i, '').trim()
        );

        // Ensure we have enough replies (fallback)
        while (replies.length < replyCount) {
            replies.push(replies[0] || 'Sorry, I couldn\'t generate enough unique replies. Please try again.');
        }

        // Take only the requested amount
        replies = replies.slice(0, replyCount);

        res.json({ replies });

    } catch (error) {
        console.error('Reply generation error:', { status: error.status, code: error.code, name: error.name });
        res.status(502).json({ error: 'AI Notes could not generate replies right now. Please try again.' });
    }
});

// ==================== FOLLOW-UP ENDPOINT ====================
app.post('/api/followup', async (req, res) => {
    try {
        const { context, question, type = 'note' } = req.body;

        if (!context || !question) {
            return res.status(400).json({ error: 'Context and question are required' });
        }

        let prompt;
        if (type === 'reply') {
            prompt = `You are an AI assistant helping to refine and improve message replies.

ORIGINAL REPLY:
"""
${context}
"""

USER'S REQUEST:
"""
${question}
"""

INSTRUCTIONS:
1. Modify the original reply according to the user's request
2. Keep the overall structure unless asked to change it
3. Maintain appropriate tone and formatting
4. Return ONLY the refined reply, no explanations

Generate the refined reply now:`;
        } else {
            prompt = `You are an AI assistant helping to expand on and clarify notes.

ORIGINAL NOTES:
"""
${context}
"""

USER'S FOLLOW-UP QUESTION:
"""
${question}
"""

INSTRUCTIONS:
1. Provide a clear, detailed answer to the user's question
2. Reference the original notes when relevant
3. Use bullet points and formatting for clarity
4. If asked to expand a section, provide comprehensive additional information
5. Keep the same professional tone as the original notes

FORMAT YOUR RESPONSE AS:
## Follow-up Answer

[Your detailed response here with bullet points where appropriate]

Generate the follow-up response now:`;
        }

        const result = await generateWithRetry(2048, prompt);
        const response = result.text;

        res.json({ response });

    } catch (error) {
        console.error('Follow-up generation error:', { status: error.status, code: error.code, name: error.name });
        res.status(502).json({ error: 'AI Notes could not generate a follow-up right now. Please try again.' });
    }
});

// ==================== SENTIMENT ENDPOINT ====================
app.post('/api/sentiment', async (req, res) => {
    try {
        const { text = req.body.message } = req.body;
        if (!text) return res.status(400).json({ error: 'Text is required' });

        const prompt = `Analyze the sentiment of this text.
        
TEXT: "${text}"

Determine if it is Positive, Negative, or Neutral.
Also provide a confidence score (0-100%) and a brief explanation.

FORMAT AS JSON:
{
    "type": "positive/negative/neutral/angry/frustrated/happy/sad/urgent/confused",
    "emoji": "appropriate emoji",
    "label": "Brief Label",
    "color": "Hex color without opacity (e.g. #10B981)",
    "score": 0.85,
    "explanation": "Brief explanation here"
}
`;

        const result = await generateWithRetry(512, prompt);
        const textResponse = result.text;

        // Extract JSON from response
        const jsonMatch = textResponse.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const data = JSON.parse(jsonMatch[0]);
            res.json(data);
        } else {
            res.json({ sentiment: 'Neutral', score: 0.5, explanation: 'Could not analyze.' });
        }

    } catch (error) {
        console.error('Sentiment error:', { status: error.status, code: error.code, name: error.name });
        res.status(500).json({ error: 'Failed' });
    }
});

// ==================== TRANSLATE ENDPOINT ====================
app.post('/api/translate', async (req, res) => {
    try {
        const { text, targetLanguage } = req.body;
        if (!text || !targetLanguage) {
            return res.status(400).json({ error: 'Text and target language are required' });
        }

        const prompt = `Translate the following text to ${targetLanguage}.
        
TEXT: "${text}"

RULES:
- Maintain the original tone and meaning
- Return ONLY the translated text
- Do not add explanations or notes
`;

        const result = await generateWithRetry(2048, prompt);
        res.json({ translatedText: result.text });

    } catch (error) {
        console.error('Translate error:', { status: error.status, code: error.code, name: error.name });
        res.status(500).json({ error: 'Failed' });
    }
});

// ==================== POLISH ENDPOINT ====================
app.post('/api/polish', async (req, res) => {
    try {
        const { text, mode } = req.body;
        if (!text) return res.status(400).json({ error: 'Text is required' });

        const prompt = `Rewrite this text in a ${mode || 'professional'} style.
        
TEXT: "${text}"

RULES:
- Maintain the original meaning
- Improve grammar and flow
- Match the requested style (${mode})
- Return ONLY the rewritten text, no explanations.
`;

        const result = await generateWithRetry(2048, prompt);
        res.json({ polishedText: result.text });

    } catch (error) {
        console.error('Polish error:', { status: error.status, code: error.code, name: error.name });
        res.status(500).json({ error: 'Failed' });
    }
});

// ==================== CREDITS SYSTEM ENDPOINTS ====================
app.use('/api/credits', createCreditRouter({ credits: creditService, purchases: purchaseService, appleSubscriptions }));

// ==================== REVENUECAT WEBHOOK ====================

app.post('/api/webhooks/revenuecat', createRevenueCatHandler({
    User, PendingPurchase, credits: creditService,
    reconcilePurchases: user => purchaseService.sync(user, { required: true }),
    subscriptionEvent: event => appleSubscriptions.webhook(event),
    secret: process.env.REVENUECAT_WEBHOOK_SECRET,
    allowSandbox: process.env.REVENUECAT_ALLOW_SANDBOX === 'true',
    notify: async (code, amount, newBalance) => {
        const notifToken = await NotificationToken.findOne({ recoveryCode: code });
        if (notifToken) await sendPushNotifications([notifToken.token], {
            title: 'Purchase Successful! 🌟',
            body: `${amount} Credits have been added to your account.`,
            data: { type: 'CREDIT_UPDATE', newBalance },
        });
    },
}));

// ==================== APP CONFIG & ADS ====================

// Get Master App Config (Banners, Ads, Alerts)
app.get('/api/config', async (req, res) => {
    try {
        const config = await getAppConfig();
        res.set('Cache-Control', 'no-store');
        res.set('Cache-Control', 'no-store');
        res.json({ ...config.toObject(), ...publicMaintenance(config), ...releaseConfig(config), welcomePackCredits: getWelcomeCredits(config), subscriberDailyLimit: getSubscriberDailyLimit(config), welcomeCreditsConfigurable: true, creditPolicyVersion: 'one-time-v1', generationBillingVersion: 2, subscriptionUsageVersion: 1, purchasedCreditFallback: true, desktopWalkthroughNarration: true });
    } catch (error) {
        res.status(error.status || 500).json({ error: error.status ? error.message : 'Failed to fetch config' });
    }
});

// Legacy ad configuration endpoint; reward claims use the shared credit router.
app.get('/api/config/ad-offer', async (req, res) => {
    try {
        const config = await getAppConfig();
        res.json({
            STANDARD_REWARD: config.adRewards.standardReward,
            SPECIAL_OFFER_ACTIVE: config.adRewards.specialOfferActive,
            SPECIAL_REWARD: config.adRewards.specialReward,
            SPECIAL_MESSAGE: config.adRewards.specialMessage,
        });
    } catch (error) { res.status(503).json({ error: 'Configuration is temporarily unavailable' }); }
});

// ==========================================
// PUSH NOTIFICATIONS
// ==========================================

// Notification Token Schema (using mongoose for consistency)
const NotificationTokenSchema = new mongoose.Schema({
    token: { type: String, required: true, unique: true, index: true },
    platform: { type: String, default: 'unknown' },
    recoveryCode: { type: String, default: null },
    appVersion: { type: String, default: '1.0.0' },
    enabled: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

const NotificationToken = mongoose.model('NotificationToken', NotificationTokenSchema);

// Register push token
app.post('/api/notifications/register', async (req, res) => {
    try {
        const { token, platform, recoveryCode, appVersion } = req.body;

        if (!token) {
            return res.status(400).json({ error: 'Token is required' });
        }

        if (!Expo.isExpoPushToken(token)) {
            return res.status(400).json({ error: 'Invalid Expo push token format' });
        }

        await NotificationToken.findOneAndUpdate(
            { token },
            {
                platform: platform || 'unknown',
                recoveryCode: recoveryCode || null,
                appVersion: appVersion || '1.0.0',
                enabled: true,
                updatedAt: new Date()
            },
            { upsert: true, new: true }
        );

        console.log(`✅ Push token registered: ${platform || 'unknown'}`);

        res.json({
            success: true,
            message: 'Token registered successfully'
        });
    } catch (error) {
        console.error('Register token error:', error);
        res.status(500).json({ error: 'Failed to register token', details: error.message });
    }
});

// Unregister push token
app.delete('/api/notifications/unregister', async (req, res) => {
    try {
        const { token } = req.body;

        if (!token) {
            return res.status(400).json({ error: 'Token is required' });
        }

        await NotificationToken.deleteOne({ token });

        res.json({
            success: true,
            message: 'Token unregistered successfully'
        });
    } catch (error) {
        console.error('Unregister token error:', error);
        res.status(500).json({ error: 'Failed to unregister token', details: error.message });
    }
});

// Send notification to all users
app.post('/api/notifications/send-all', async (req, res) => {
    try {
        const { title, body, data, platform } = req.body;

        if (!title || !body) {
            return res.status(400).json({ error: 'Title and body are required' });
        }

        // Build query - optionally filter by platform
        const query = { enabled: true };
        if (platform && ['ios', 'android'].includes(platform.toLowerCase())) {
            query.platform = platform.toLowerCase();
        }

        const tokens = await NotificationToken.find(query).select('token');

        if (tokens.length === 0) {
            return res.json({ success: true, message: 'No registered devices found', sent: 0 });
        }

        const pushTokens = tokens.map(t => t.token);
        const result = await sendPushNotifications(pushTokens, { title, body, data: data || {} });

        res.json({
            success: true,
            sent: result.success,
            failed: result.failed,
            total: tokens.length
        });
    } catch (error) {
        console.error('Send-all error:', error);
        res.status(500).json({ error: 'Failed to send notifications', details: error.message });
    }
});

// Helper: Send push notifications using Expo SDK
async function sendPushNotifications(expoPushTokens, { title, body, data }) {
    const messages = [];

    for (const pushToken of expoPushTokens) {
        if (!Expo.isExpoPushToken(pushToken)) {
            console.error(`❌ Invalid token skipped: ${pushToken}`);
            continue;
        }

        messages.push({
            to: pushToken,
            sound: 'default',
            title,
            body,
            data: data || {},
        });
    }

    const chunks = expo.chunkPushNotifications(messages);
    let successCount = 0;
    let failCount = 0;

    for (const chunk of chunks) {
        try {
            const ticketChunk = await expo.sendPushNotificationsAsync(chunk);

            for (let i = 0; i < ticketChunk.length; i++) {
                const ticket = ticketChunk[i];
                if (ticket.status === 'ok') {
                    successCount++;
                } else if (ticket.status === 'error') {
                    failCount++;
                    console.error(`❌ Push failed:`, ticket.message);

                    // Auto-cleanup: Remove token if device uninstalled app
                    if (ticket.details?.error === 'DeviceNotRegistered') {
                        const invalidToken = chunk[i].to;
                        await NotificationToken.deleteOne({ token: invalidToken });
                        console.log(`🗑️ Deleted invalid token: ${invalidToken}`);
                    }
                }
            }
        } catch (error) {
            console.error('Batch send error:', error);
            failCount += chunk.length;
        }
    }

    return { success: successCount, failed: failCount };
}

// Get notification stats
app.get('/api/notifications/stats', async (req, res) => {
    try {
        const total = await NotificationToken.countDocuments({ enabled: true });
        const ios = await NotificationToken.countDocuments({ enabled: true, platform: 'ios' });
        const android = await NotificationToken.countDocuments({ enabled: true, platform: 'android' });

        res.json({
            success: true,
            stats: { total, ios, android }
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to get stats', details: error.message });
    }
});


// ==================== PENDING PURCHASES ADMIN ====================

app.use('/api/admin', createPurchaseAdminRouter({
    PendingPurchase, credits: creditService, secret: process.env.ADMIN_API_SECRET,
}));

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', message: 'AI App Backend is running', version: '2.0.0', generationModel: MODEL });
});

// Recover abandoned reservations after a process restart and on a bounded timer.
if (require.main === module) {
    mongoose.connection.asPromise().then(async () => {
        await GenerationRequest.init();
        await generationService.recoverExpired();
        const sweep = setInterval(() => generationService.recoverExpired().catch(error => console.error('AI reconciliation deferred:', error.message)), 60000);
        sweep.unref();
    }).catch(error => console.error('AI charging initialization failed:', error.message));
}

// Start server
if (require.main === module) app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`✨ SERVER VERSION: v3.0 (With Credits System)`);
    console.log(`📝 Notes endpoint: POST /api/notes`);
    console.log(`💬 Reply endpoint: POST /api/reply`);
    console.log(`💳 Credits endpoints: /api/credits/*`);
});

module.exports = { app };
