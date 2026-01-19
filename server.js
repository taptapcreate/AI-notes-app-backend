const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
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

const app = express();
const PORT = process.env.PORT || 3000;

// MongoDB Connection
const DB_NAME = 'ai_notes_app';

const AppConfig = require('./models/AppConfig');

// Helper: Get App Config (Singleton)
const getAppConfig = async () => {
    try {
        let config = await AppConfig.findOne({ key: 'master_config' });
        if (!config) {
            console.log('⚠️ No AppConfig found on DB. Creating default...');
            config = new AppConfig();
            await config.save();
        }
        return config;
    } catch (error) {
        console.error('Error fetching config:', error);
        // Fallback in case of DB error
        return {
            adRewards: {
                enabled: false,
                active: false,
                standardReward: 1,
                specialOfferActive: false,
                specialReward: 3,
                specialMessage: "Special Offer!"
            }
        };
    }
};

mongoose.connect(process.env.MONGODB_URI, { dbName: DB_NAME })
    .then(() => console.log(`✅ Connected to MongoDB Atlas (${DB_NAME})`))
    .catch(err => console.error('❌ MongoDB connection error:', err));

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Get the model with configuration
const getModel = (maxTokens = 2048, modelName = 'gemini-2.0-flash') => {
    return genAI.getGenerativeModel({
        model: modelName,
        generationConfig: {
            temperature: 0.7,
            topP: 0.9,
            maxOutputTokens: maxTokens,
        },
    });
};

// Get the model for streaming responses
const getStreamingModel = (maxTokens = 4096, modelName = 'gemini-2.0-flash') => {
    return genAI.getGenerativeModel({
        model: modelName,
        generationConfig: {
            temperature: 0.7,
            topP: 0.9,
            maxOutputTokens: maxTokens,
        },
    });
};

// Helper: Sleep function for delays
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Helper: Fetch Website Content
const fetchWebsiteContent = async (url) => {
    try {
        const { data } = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });
        const $ = cheerio.load(data);

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

        return content.substring(0, 20000); // Limit context window
    } catch (error) {
        if (error.response && error.response.status === 403) {
            throw new Error('WEB_ACCESS_BLOCKED: This website blocks automated access. Please copy/paste content manually.');
        }
        throw new Error(`Failed to fetch website: ${error.message}`);
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

        return transcript.substring(0, 25000); // Limit context window
    } catch (error) {
        if (error.message.includes('YOUTUBE_BLOCK')) throw error;
        throw new Error(`Failed to fetch YouTube transcript: ${error.message}`);
    }
};

// Helper: API Call with Retry Logic (Exponential Backoff)
const generateWithRetry = async (model, content, retries = 3, delay = 2000) => {
    try {
        return await model.generateContent(content);
    } catch (error) {
        const isRateLimit = error.message.includes('429') || error.message.includes('Too Many Requests');
        const isServiceUnavailable = error.message.includes('503') || error.message.includes('Overloaded');

        if (retries > 0 && (isRateLimit || isServiceUnavailable)) {
            console.log(`⚠️ API Busy (Rate Limit). Retrying in ${delay / 1000}s... (${retries} attempts left)`);
            await sleep(delay);
            return generateWithRetry(model, content, retries - 1, delay * 2);
        }
        throw error;
    }
};

// ==================== SHARED GUIDES ====================

// Note length instructions with token limits
const lengthGuides = {
    brief: {
        instruction: 'Be VERY concise. Maximum 5-6 bullet points total. Focus ONLY on the most critical information. Skip minor details. Keep it SHORT.',
        maxTokens: 1000
    },
    standard: {
        instruction: 'Be comprehensive but clear. Include all key points with moderate detail. Aim for 10-15 bullet points with explanations.',
        maxTokens: 2500
    },
    detailed: {
        instruction: 'Be extremely thorough and in-depth. Include ALL information with comprehensive explanations, context, examples, and supporting details. Aim for 20-30 detailed bullet points. Expand on every concept.',
        maxTokens: 5000
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
app.post('/api/notes', async (req, res) => {
    try {
        const { type, content, noteLength = 'standard', format = 'bullet', tone = 'professional', language = 'english', instruction = '', isPro = false } = req.body;

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

        // PRO: Distinct Formatting Logic
        const proFormatting = isPro
            ? `
FORMAT YOUR RESPONSE AS:
# [Professional Title]

⭐ **Executive Summary**
[A high-level synthesis of the core message (2-3 sentences). Not just a summary, but the "Bottom Line".]

🧐 **Context & Analysis**
[Why this matters, underlying concepts, or strategic importance]

📝 **Detailed Breakdown**
• Section headers in bold
• Organized content with strict hierarchy
• Sub-points for depth

🚀 **Strategic Implications / Actionable Insights**
• What to do next or how to apply this knowledge
• Potential impact or hidden opportunities

📌 **Key Takeaways**
• [Critical point 1]
• [Critical point 2]
`
            : `
FORMAT YOUR RESPONSE AS:
# Appropriate Title Based on Content

• Section headers in bold
• Organized content with bullet points
• Sub-points indented properly

## Key Takeaways
• Most important point 1
• Most important point 2
• Most important point 3
`;

        let prompt = '';
        let result;

        switch (type) {
            case 'text':
                prompt = `You are an expert AI assistant. Your task depends on the input content:
    ${proInstruction}

    1. **IF INPUT IS A QUESTION/INSTRUCTION** (e.g., "Explain Quantum Physics", "Write a poem"):
       - **ANSWER** the question or **EXECUTE** the instruction directly.
       - Do NOT summarize the request (e.g., don't say "The user asked for...").
       - Provide the actual detailed answer/content in the "Detailed Notes" section.

    2. **IF INPUT IS CONTENT** (e.g., an article, notes, meeting transcript):
       - Transform it into perfectly organized, professional notes as usual.

    INPUT CONTENT:
    """
    ${content}
    """

    LENGTH REQUIREMENT: ${lengthInstruction}
    FORMAT REQUIREMENT: ${formatInstruction}
    TONE REQUIREMENT: ${toneInstruction}
    LANGUAGE REQUIREMENT: ${languageInstruction}
USER INTENT/INSTRUCTION: ${instruction || 'None provided. Generate standard professional notes.'}

INSTRUCTIONS:
1. Create a clear, hierarchical structure with sections
2. Extract key information according to the length requirement
3. Use bullet points (•) for lists, not dashes
4. Bold important terms by surrounding them with **asterisks**
5. Add a "📌 Key Takeaways" section at the end

${proFormatting}

Generate the notes now:`;

                const textModel = getModel(maxTokens);
                result = await generateWithRetry(textModel, prompt);
                break;

            case 'image':
                prompt = `You are an expert at analyzing images. Your task depends on the image content:
    ${proInstruction}

    1. **IF IMAGE CONTAINS A QUESTION/PROBLEM** (e.g., homework, exam question):
       - **SOLVE** or **ANSWER** it.
       - Explain the solution step-by-step in the "Detailed Notes" section.

    2. **IF IMAGE IS CONTENT** (e.g., a diagram, screenshot, photo of notes):
       - Analyze and extract the information into satisfying notes.

    LENGTH REQUIREMENT: ${lengthInstruction}
    FORMAT REQUIREMENT: ${formatInstruction}
    TONE REQUIREMENT: ${toneInstruction}
    LANGUAGE REQUIREMENT: ${languageInstruction}
    USER INTENT/INSTRUCTION: ${instruction || 'None provided.'}

    INSTRUCTIONS:
    1. If text/handwriting: Transcribe accurately.
    2. If diagram/chart: Explain insights and data.
    3. If question: Provide the solution.
    4. Apply requested Tone/Format/Language.

FORMAT YOUR RESPONSE AS:
📷 **Image Analysis Notes**

**What This Shows:**
[Brief description]

**Extracted Content:**
• [Organized bullet points of all information]

📌 **Key Points**
• [Important observations]

Generate the notes now following all requirements:`;

                const visionModel = getModel(maxTokens);
                result = await generateWithRetry(visionModel, [
                    prompt,
                    {
                        inlineData: {
                            mimeType: 'image/jpeg',
                            data: content,
                        },
                    },
                ]);
                break;

            case 'voice':
                prompt = `You are an expert AI assistant. Your task depends on the audio content:
    ${proInstruction}

    1. **IF AUDIO IS A QUESTION/INSTRUCTION** (e.g., "Tell me about the Event Loop", "How do I make pasta?"):
       - **ANSWER** the question or **FULFILL** the request directly.
       - The "Summary" should state the topic (e.g., "Explanation of Event Loop").
       - The "Detailed Notes" MUST contain the **ACTUAL ANSWER/EXPLANATION**, NOT a description of the request (e.g., do NOT say "The speaker asked about...").
       - Treat the audio as a prompt for you to answer.

    2. **IF AUDIO IS RECORDED CONTENT** (e.g., meeting, lecture, voice memo):
       - **TRANSCRIBE** and **SUMMARIZE** the content into organized notes.

    LENGTH REQUIREMENT: ${lengthInstruction}
    FORMAT REQUIREMENT: ${formatInstruction}
    TONE REQUIREMENT: ${toneInstruction}
    LANGUAGE REQUIREMENT: ${languageInstruction}
    USER INTENT/INSTRUCTION: ${instruction || 'None provided.'}

    INSTRUCTIONS:
    1. Detect if this is a User Question vs. Recorded Content.
    2. If Question: Provide the answer.
    3. If Content: Transcribe and summarize.
    4. Clean up filler words.
    5. Apply requested Tone/Format/Language.

FORMAT YOUR RESPONSE AS:
🎙️ **Audio Notes**

**Summary:**
[2-3 sentence summary of what was discussed]

**Detailed Notes:**
• [Organized content by topic]

📌 **Key Points & Action Items**
• [Important takeaways]

Generate the notes now following all requirements:`;

                const audioModel = getModel(maxTokens);

                // Try different mime types based on what Expo typically records
                // iOS uses .m4a (audio/m4a), Android may use .3gp or .m4a
                let audioMimeType = 'audio/mp4'; // Default fallback

                // Try to detect from content or use common mobile formats
                const supportedMimeTypes = ['audio/mp4', 'audio/m4a', 'audio/mpeg', 'audio/wav'];

                try {
                    result = await generateWithRetry(audioModel, [
                        prompt,
                        {
                            inlineData: {
                                mimeType: audioMimeType,
                                data: content,
                            },
                        },
                    ]);
                } catch (audioError) {
                    // If audio processing fails, try with a transcription-only approach
                    console.log('Direct audio failed, attempting text-based processing');

                    // Fall back to asking for help with the audio
                    const fallbackPrompt = `The user has recorded an audio note but we couldn't process the audio directly.

Please provide a template they can use to organize their voice notes:

# Voice Notes Template

**Recording Date:** Today's date

**Main Topic:**
Describe what the recording was about

**Key Points Discussed:**
• First key point
• Second key point
• Third key point

**Action Items:**
• ⏳ Task 1
• ⏳ Task 2

**Additional Notes:**
Any other observations

---
Tip: Try recording in a quieter environment for better results!`;

                    result = await generateWithRetry(audioModel, fallbackPrompt);
                }
                break;

            case 'pdf':
                prompt = `You are an expert at analyzing documents. Analyze this PDF document thoroughly and create comprehensive notes.
    ${proInstruction}

LENGTH REQUIREMENT: ${lengthInstruction}
FORMAT REQUIREMENT: ${formatInstruction}
TONE REQUIREMENT: ${toneInstruction}
LANGUAGE REQUIREMENT: ${languageInstruction}
USER INTENT/INSTRUCTION: ${instruction || 'None provided. Generate standard professional notes.'}

INSTRUCTIONS:
1. Provide a clear summary of the document's purpose
2. Extract all key findings, data, and arguments
3. Organize the content logically (headers, bullet points)
4. Highlight any important dates, names, or requirements
5. If it's a form or template, describe its structure and required fields

FORMAT YOUR RESPONSE AS:
📄 **Document Analysis**

**Overview:**
[Brief summary of the document]

**Detailed Content:**
• [Organized detailed notes]

**Key Takeaways:**
• [Important points]

Generate the notes now:`;

                const pdfModel = getModel(maxTokens);
                result = await generateWithRetry(pdfModel, [
                    prompt,
                    {
                        inlineData: {
                            mimeType: 'application/pdf',
                            data: content,
                        },
                    },
                ]);
                break;

            case 'website':
                const websiteText = await fetchWebsiteContent(content);
                prompt = `You are an expert web researcher. Summarize the following website content into clear, organized notes.
    ${proInstruction}

URL: ${content}

WEBSITE CONTENT:
"""
${websiteText}
"""

LENGTH REQUIREMENT: ${lengthInstruction}
FORMAT REQUIREMENT: ${formatInstruction}
TONE REQUIREMENT: ${toneInstruction}
LANGUAGE REQUIREMENT: ${languageInstruction}
USER INTENT/INSTRUCTION: ${instruction || 'None provided. Generate standard professional notes.'}

INSTRUCTIONS:
1. Identify the main topic and key arguments/points
2. Extract important data, dates, or quotes
3. Ignore navigation elements or footer text if any slipped through
4. Organize logical sections with headers

FORMAT YOUR RESPONSE AS:
🌐 **Website Summary**

**Source:** [${content}](${content})

# Title of Article/Page

**Overview**
[Brief summary of what this page is about]

**Key Notes**
• Point 1
• Point 2
• Point 3

**Important Details**
• Detail A
• Detail B

Generate the notes now:`;

                const webModel = getModel(maxTokens);
                result = await generateWithRetry(webModel, prompt);
                break;

            case 'youtube':
                const transcript = await fetchYouTubeTranscript(content);
                prompt = `You are an expert video summarizer. Create detailed notes from this YouTube video transcript.
    ${proInstruction}

VIDEO URL: ${content}

TRANSCRIPT:
"""
${transcript}
"""

LENGTH REQUIREMENT: ${lengthInstruction}
FORMAT REQUIREMENT: ${formatInstruction}
TONE REQUIREMENT: ${toneInstruction}
LANGUAGE REQUIREMENT: ${languageInstruction}
USER INTENT/INSTRUCTION: ${instruction || 'None provided. Generate standard professional notes.'}

INSTRUCTIONS:
1. Reconstruct the logical flow of the video
2. Group related points into sections with timestamps if possible (guess based on flow, or just use logical sections)
3. Capture the core message and all supporting details
4. Ignore filler speech ("um", "guys", "welcome back")

FORMAT YOUR RESPONSE AS:
📺 **Video Notes**

**Source:** [Watch Video](${content})

# Video Title / Topic

**Executive Summary**
[Concise summary of the video]

**Key Topics**
## Topic 1
• Detail
• Detail

## Topic 2
• Detail
• Detail

**Key Takeaways**
• Takeaway 1
• Takeaway 2

Generate the notes now:`;

                const ytModel = getModel(maxTokens);
                result = await generateWithRetry(ytModel, prompt);
                break;

            default:
                return res.status(400).json({ error: 'Invalid input type' });
        }

        let notes = result.response.text();

        // Check if response was truncated (cut off mid-sentence)
        const finishReason = result.response.candidates?.[0]?.finishReason;

        // Smart continuation: If truncated, ask AI to complete
        if (finishReason === 'MAX_TOKENS') {
            try {
                const continuationPrompt = `The following notes were cut off mid-way. Complete them naturally from where they stopped. Do NOT repeat any content, just continue seamlessly.

INCOMPLETE NOTES (continue from here):
"""
${notes.slice(-500)}
"""

Continue the notes now, picking up exactly where it stopped:`;

                const continuationModel = getModel(1500); // Extra tokens for completion
                const continuationResult = await generateWithRetry(continuationModel, continuationPrompt);
                const continuation = continuationResult.response.text();

                // Combine: Remove potential overlap and merge
                notes = notes.trim() + '\n' + continuation.trim();
            } catch (contError) {
                console.log('Continuation failed, using original:', contError.message);
                // If continuation fails, just clean up the truncation
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
        }

        res.json({ notes });

    } catch (error) {
        console.error('Notes generation error:', error);
        res.status(500).json({ error: 'Failed to generate notes', details: error.message });
    }
});
// ==================== STREAMING NOTES ENDPOINT ====================
app.post('/api/notes/stream', async (req, res) => {
    try {
        const { type, content, noteLength = 'standard', format = 'bullet', tone = 'professional', language = 'english' } = req.body;

        if (!content) {
            return res.status(400).json({ error: 'Content is required' });
        }

        // Set SSE headers
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.flushHeaders();

        const lengthConfig = lengthGuides[noteLength] || lengthGuides.standard;
        const lengthInstruction = lengthConfig.instruction;
        const maxTokens = lengthConfig.maxTokens;

        const formatInstruction = formatGuides[format] || formatGuides.bullet;
        const toneInstruction = toneGuides[tone] || toneGuides.professional;

        const languageInstruction = language && language.toLowerCase() !== 'english'
            ? `IMPORTANT: Generate ALL content in ${language}.`
            : 'Keep the output in English.';

        let prompt = `You are an expert note-taking assistant. Transform the following content into perfectly organized, professional notes.

INPUT CONTENT:
"""
${content}
"""

LENGTH REQUIREMENT: ${lengthInstruction}
FORMAT REQUIREMENT: ${formatInstruction}
TONE REQUIREMENT: ${toneInstruction}
LANGUAGE REQUIREMENT: ${languageInstruction}

INSTRUCTIONS:
1. Create a clear, hierarchical structure with sections
2. Extract key information according to the length requirement
3. Use bullet points (•) for lists
4. Bold important terms with **asterisks**
5. Add a "📌 Key Takeaways" section at the end

Generate the notes now:`;

        const model = getStreamingModel(maxTokens);
        const streamResult = await model.generateContentStream(prompt);

        // Stream each chunk as SSE
        for await (const chunk of streamResult.stream) {
            const chunkText = chunk.text();
            if (chunkText) {
                res.write(`data: ${JSON.stringify({ text: chunkText })}\n\n`);
            }
        }

        // Signal completion
        res.write('data: [DONE]\n\n');
        res.end();

    } catch (error) {
        console.error('Streaming notes error:', error);
        res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
        res.end();
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

        const model = getModel();
        const result = await generateWithRetry(model, prompt);
        const responseText = result.response.text();

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
        console.error('Reply generation error:', error);
        res.status(500).json({ error: 'Failed to generate reply', details: error.message });
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

        const model = getModel();
        const result = await generateWithRetry(model, prompt);
        const response = result.response.text();

        res.json({ response });

    } catch (error) {
        console.error('Follow-up generation error:', error);
        res.status(500).json({ error: 'Failed to generate follow-up', details: error.message });
    }
});

// ==================== SENTIMENT ENDPOINT ====================
app.post('/api/sentiment', async (req, res) => {
    try {
        const { text } = req.body;
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

        const model = getModel(512, 'gemini-1.5-flash-8b');
        const result = await generateWithRetry(model, prompt);
        const textResponse = result.response.text();

        // Extract JSON from response
        const jsonMatch = textResponse.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const data = JSON.parse(jsonMatch[0]);
            res.json(data);
        } else {
            res.json({ sentiment: 'Neutral', score: 0.5, explanation: 'Could not analyze.' });
        }

    } catch (error) {
        console.error('Sentiment error:', error);
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

        const model = getModel();
        const result = await generateWithRetry(model, prompt);
        res.json({ translatedText: result.response.text() });

    } catch (error) {
        console.error('Translate error:', error);
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

        const model = getModel();
        const result = await generateWithRetry(model, prompt);
        res.json({ polishedText: result.response.text() });

    } catch (error) {
        console.error('Polish error:', error);
        res.status(500).json({ error: 'Failed' });
    }
});

// ==================== CREDITS SYSTEM ENDPOINTS ====================

// Register new user - Generate recovery code
app.post('/api/credits/register', async (req, res) => {
    try {
        // Generate unique recovery code
        let recoveryCode;
        let isUnique = false;

        while (!isUnique) {
            recoveryCode = User.generateRecoveryCode();
            const existing = await User.findOne({ recoveryCode });
            if (!existing) isUnique = true;
        }

        // Create new user with dynamic config values
        const config = await getAppConfig();
        const { platform } = req.body;
        const isDaily = config.dailyFreeCreditsEnabled ?? true;
        const user = new User({
            recoveryCode,
            credits: 0,
            freeCreditsRemaining: isDaily ? config.freeDailyCredits : 0,
            welcomePackBalance: isDaily ? 0 : config.welcomePackCredits,
            welcomePackVersion: isDaily ? 0 : config.welcomePackVersion,
            platform: platform ? platform.toLowerCase() : 'other',
        });

        await user.save();

        const currentFree = isDaily ? user.freeCreditsRemaining : user.welcomePackBalance;

        res.json({
            success: true,
            recoveryCode,
            credits: user.credits,
            freeCreditsRemaining: currentFree,
            userServerVersion: user.welcomePackVersion || 0,
        });
    } catch (error) {
        console.error('Register error:', error);
        res.status(500).json({ error: 'Failed to register', details: error.message });
    }
});

// Get balance by recovery code
app.get('/api/credits/balance/:code', async (req, res) => {
    try {
        const { code } = req.params;
        const user = await User.findOne({ recoveryCode: code.toUpperCase() });

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Reset daily free credits if mode is enabled
        const config = await getAppConfig();
        if (config.dailyFreeCreditsEnabled) {
            const wasReset = user.resetDailyCreditsIfNeeded(config.freeDailyCredits);

            // AGGRESSIVE RESET: If daily mode is enabled, user must NOT have more or less than the daily limit 
            // if we just switched mode today. Irrespective of when it was last reset, 
            // the kill switch being ON means they get exactly the daily limit.
            if (!wasReset && user.freeCreditsRemaining !== config.freeDailyCredits) {
                user.freeCreditsRemaining = config.freeDailyCredits;
                await user.save();
            } else if (wasReset) {
                await user.save();
            }
        } else {
            // WELCOME PACK AUTO-SYNC: If daily mode is DISABLED, check if version has changed
            const remoteVersion = config.welcomePackVersion || 1;
            const currentVersion = user.welcomePackVersion || 0;

            if (remoteVersion > currentVersion) {
                console.log(`🎁 Auto-updating Welcome Pack for user ${user.recoveryCode}: V${currentVersion} -> V${remoteVersion}`);
                user.welcomePackBalance = config.welcomePackCredits || 12;
                user.welcomePackVersion = remoteVersion;
                await user.save();
            }
        }

        // Update last active
        user.lastActive = new Date();
        await user.save();

        // Return balance based on which mode is active
        const isDaily = config.dailyFreeCreditsEnabled ?? true;
        const currentFree = isDaily ? user.freeCreditsRemaining : user.welcomePackBalance;

        res.json({
            success: true,
            credits: user.credits,
            adCredits: user.adCredits || 0,
            freeCreditsRemaining: currentFree,
            userServerVersion: user.welcomePackVersion || 0,
            totalAvailable: user.credits + (user.adCredits || 0) + currentFree,
        });
    } catch (error) {
        console.error('Balance error:', error);
        res.status(500).json({ error: 'Failed to get balance', details: error.message });
    }
});

// Sync Welcome Pack Version & Credits (For Lifetime/Total Credit mode)
app.post('/api/credits/sync-welcome-pack', async (req, res) => {
    try {
        const { code, version, credits } = req.body;

        if (!code) return res.status(400).json({ error: 'Recovery code is required' });

        const user = await User.findOne({ recoveryCode: code.toUpperCase() });
        if (!user) return res.status(404).json({ error: 'User not found' });

        // Only update if the provided version is newer than what we have
        const currentVersion = user.welcomePackVersion || 0;
        if (version > currentVersion) {
            user.welcomePackBalance = credits;
            user.welcomePackVersion = version;
            await user.save();

            return res.json({
                success: true,
                newBalance: user.welcomePackBalance,
                version: user.welcomePackVersion
            });
        }

        // If version is matched or higher, still return success so the client can update its local marker
        res.json({
            success: true,
            version: user.welcomePackVersion,
            newBalance: user.welcomePackBalance,
            message: 'User already at this or higher version'
        });
    } catch (error) {
        console.error('Welcome pack sync error:', error);
        res.status(500).json({ error: 'Failed to sync welcome pack' });
    }
});

// Add credits (after purchase) - with transaction tracking to prevent abuse
app.post('/api/credits/add', async (req, res) => {
    try {
        const { code, credits, transactionId } = req.body;

        if (!code || !credits || !transactionId) {
            return res.status(400).json({ error: 'Code, credits, and transactionId are required' });
        }

        const user = await User.findOne({ recoveryCode: code.toUpperCase() });

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Check if transaction already processed (prevent restore abuse)
        if (user.hasProcessedTransaction(transactionId)) {
            return res.json({
                success: false,
                message: 'Transaction already processed',
                credits: user.credits,
                alreadyProcessed: true,
            });
        }

        // Add credits and record transaction
        user.credits += credits;
        user.processedTransactions.push({
            transactionId,
            credits,
            processedAt: new Date(),
        });

        await user.save();

        res.json({
            success: true,
            creditsAdded: credits,
            newBalance: user.credits,
            transactionId,
        });
    } catch (error) {
        console.error('Add credits error:', error);
        res.status(500).json({ error: 'Failed to add credits', details: error.message });
    }
});

// Use credits
app.post('/api/credits/use', async (req, res) => {
    try {
        const { code, amount } = req.body;

        if (!code || !amount) {
            return res.status(400).json({ error: 'Code and amount are required' });
        }

        const user = await User.findOne({ recoveryCode: code.toUpperCase() });

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Reset daily free credits if needed
        const config = await getAppConfig();
        user.resetDailyCreditsIfNeeded(config.freeDailyCredits);

        const isDaily = config.dailyFreeCreditsEnabled ?? true;
        const currentFreeFieldName = isDaily ? 'freeCreditsRemaining' : 'welcomePackBalance';

        const totalAvailable = user.credits + (user.adCredits || 0) + user[currentFreeFieldName];

        if (totalAvailable < amount) {
            return res.status(400).json({
                error: 'Insufficient credits',
                available: totalAvailable,
                required: amount,
            });
        }

        // Use free credits (from the correct pool) first, then ad credits, then purchased credits
        let remaining = amount;

        // 1. Free Credits (Current Active Pool)
        if (user[currentFreeFieldName] >= remaining) {
            user[currentFreeFieldName] -= remaining;
            remaining = 0;
        } else {
            remaining -= user[currentFreeFieldName];
            user[currentFreeFieldName] = 0;
        }

        // 2. Ad Credits
        if (remaining > 0) {
            const adBal = user.adCredits || 0;
            if (adBal >= remaining) {
                user.adCredits = adBal - remaining;
                remaining = 0;
            } else {
                remaining -= adBal;
                user.adCredits = 0;
            }
        }

        // 3. Purchased Credits
        if (remaining > 0) {
            user.credits -= remaining;
        }

        user.lastActive = new Date();
        await user.save();

        res.json({
            success: true,
            creditsUsed: amount,
            remainingCredits: user.credits,
            remainingAdCredits: user.adCredits || 0,
            remainingFreeCredits: user[currentFreeFieldName],
            totalAvailable: user.credits + (user.adCredits || 0) + user[currentFreeFieldName],
        });
    } catch (error) {
        console.error('Use credits error:', error);
        res.status(500).json({ error: 'Failed to use credits', details: error.message });
    }
});

// ==================== AD REWARD ENDPOINTS ====================

// ==================== APP CONFIG & ADS ====================

// Get Master App Config (Banners, Ads, Alerts)
app.get('/api/config', async (req, res) => {
    try {
        const config = await getAppConfig();
        res.json(config);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch config' });
    }
});

// Legacy Endpoint Support (Redirect to new logic if needed, or keep for older app versions)
app.get('/api/config/ad-offer', async (req, res) => {
    const config = await getAppConfig();
    res.json({
        STANDARD_REWARD: config.adRewards.standardReward,
        SPECIAL_OFFER_ACTIVE: config.adRewards.specialOfferActive,
        SPECIAL_REWARD: config.adRewards.specialReward,
        SPECIAL_MESSAGE: config.adRewards.specialMessage,
    });
});

// Claim Watch Ad Reward (1 per day)
app.post('/api/credits/claim-ad-reward', async (req, res) => {
    try {
        const { code } = req.body;
        if (!code) return res.status(400).json({ error: 'Recovery code is required' });

        const user = await User.findOne({ recoveryCode: code.toUpperCase() });
        if (!user) return res.status(404).json({ error: 'User not found' });

        // Check if already claimed today
        const now = new Date();
        const lastClaim = user.lastAdRewardDate ? new Date(user.lastAdRewardDate) : null;

        if (lastClaim && lastClaim.toDateString() === now.toDateString()) {
            return res.json({
                success: false,
                message: 'You have already claimed your daily ad reward!',
                alreadyClaimed: true,
                nextClaimTime: 'tomorrow'
            });
        }

        // Fetch Dynamic Config
        const config = await getAppConfig();
        const { adRewards } = config;

        // Determine Amount
        const rewardAmount = adRewards.specialOfferActive
            ? adRewards.specialReward
            : adRewards.standardReward;

        // Apply Reward (to Ad Credits bucket)
        if (!user.adCredits) user.adCredits = 0;
        user.adCredits += rewardAmount;
        user.lastAdRewardDate = now;

        // Log transaction
        user.processedTransactions.push({
            transactionId: `ad_reward_${Date.now()}`,
            credits: rewardAmount,
            processedAt: now,
        });

        await user.save();

        res.json({
            success: true,
            creditsAdded: rewardAmount,
            newBalance: user.adCredits,
            totalAvailable: user.credits + user.adCredits + user.freeCreditsRemaining,
            message: adRewards.specialOfferActive
                ? `Special Offer! You earned ${rewardAmount} credits!`
                : `You earned ${rewardAmount} credit! Come back tomorrow for more.`
        });

    } catch (error) {
        console.error('Ad reward claim error:', error);
        res.status(500).json({ error: 'Failed to claim reward', details: error.message });
    }
});

const rateLimit = require('express-rate-limit');

// Rate limiter for recovery attempts (5 per hour)
// Prevents brute-force guessing of recovery codes
const recoverLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 5, // Limit each IP to 5 requests per windowMs
    message: {
        error: 'Too many attempts',
        message: 'Too many failed recovery attempts. Please try again in an hour.'
    },
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});

// Recover - Switch to account with recovery code
// Optimizes DB by deleting the OLD current account if it has 0 credits and no history
// Protected by rate limiter
app.post('/api/credits/recover', recoverLimiter, async (req, res) => {
    try {
        const { code, currentCode } = req.body;

        if (!code) {
            return res.status(400).json({ error: 'Recovery code is required' });
        }

        const targetCode = code.toUpperCase();
        const currentRecoveryCode = currentCode?.toUpperCase();

        // 1. Find the target account to switch TO
        const targetAccount = await User.findOne({ recoveryCode: targetCode });

        if (!targetAccount) {
            return res.status(404).json({
                error: 'Invalid recovery code',
                message: 'No account found with this recovery code. Please check and try again.',
            });
        }

        // 2. If same code as current, just return info
        if (currentRecoveryCode && targetCode === currentRecoveryCode) {
            const config = await getAppConfig();
            targetAccount.resetDailyCreditsIfNeeded(config.freeDailyCredits);
            targetAccount.lastActive = new Date();
            await targetAccount.save();

            return res.json({
                success: true,
                recoveryCode: targetAccount.recoveryCode,
                credits: targetAccount.credits,
                adCredits: targetAccount.adCredits || 0,
                freeCreditsRemaining: targetAccount.freeCreditsRemaining,
                totalAvailable: targetAccount.credits + (targetAccount.adCredits || 0) + targetAccount.freeCreditsRemaining,
                message: 'Already using this account!',
            });
        }

        // 3. AUTO-CLEANUP: Check if we should delete the current account before switching
        if (currentRecoveryCode && targetCode !== currentRecoveryCode) {
            const currentAccount = await User.findOne({ recoveryCode: currentRecoveryCode });

            // Delete if exists AND has 0 purchased credits AND no transaction history
            if (currentAccount &&
                currentAccount.credits === 0 &&
                (!currentAccount.processedTransactions || currentAccount.processedTransactions.length === 0)) {

                await User.deleteOne({ recoveryCode: currentRecoveryCode });
                console.log(`🧹 Deleted empty account ${currentRecoveryCode} while switching to ${targetCode}`);
            }
        }

        // 4. Switch to target account
        // Log the switch event if we are switching from another account
        if (currentRecoveryCode && targetCode !== currentRecoveryCode) {
            targetAccount.switchHistory.push({
                fromCode: currentRecoveryCode,
                timestamp: new Date(),
                description: `Switched from ${currentRecoveryCode} to ${targetCode}`
            });
        }

        const config = await getAppConfig();
        targetAccount.resetDailyCreditsIfNeeded(config.freeDailyCredits);
        targetAccount.lastActive = new Date();
        await targetAccount.save();

        res.json({
            success: true,
            recoveryCode: targetAccount.recoveryCode,
            credits: targetAccount.credits,
            adCredits: targetAccount.adCredits || 0,
            freeCreditsRemaining: targetAccount.freeCreditsRemaining,
            totalAvailable: targetAccount.credits + (targetAccount.adCredits || 0) + targetAccount.freeCreditsRemaining,
            message: 'Account recovered successfully!',
        });
    } catch (error) {
        console.error('Recover error:', error);
        res.status(500).json({ error: 'Failed to recover account', details: error.message });
    }
});

// Get processed transactions (for debugging/support)
app.get('/api/credits/transactions/:code', async (req, res) => {
    try {
        const { code } = req.params;
        const user = await User.findOne({ recoveryCode: code.toUpperCase() });

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        res.json({
            success: true,
            transactions: user.processedTransactions,
        });
    } catch (error) {
        console.error('Transactions error:', error);
        res.status(500).json({ error: 'Failed to get transactions', details: error.message });
    }
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

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', message: 'AI App Backend is running', version: '2.0.0' });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`✨ SERVER VERSION: v3.0 (With Credits System)`);
    console.log(`📝 Notes endpoint: POST /api/notes`);
    console.log(`💬 Reply endpoint: POST /api/reply`);
    console.log(`💳 Credits endpoints: /api/credits/*`);
});
