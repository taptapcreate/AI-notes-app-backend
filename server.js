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

mongoose.connect(process.env.MONGODB_URI, { dbName: DB_NAME })
    .then(() => console.log(`✅ Connected to MongoDB Atlas (${DB_NAME})`))
    .catch(err => console.error('❌ MongoDB connection error:', err));

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Get the model with configuration
const getModel = () => {
    return genAI.getGenerativeModel({
        model: 'gemini-2.5-flash',
        generationConfig: {
            temperature: 0.7,
            topP: 0.9,
            maxOutputTokens: 2048,
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

// ==================== NOTES ENDPOINT ====================
app.post('/api/notes', async (req, res) => {
    try {
        const { type, content, noteLength = 'standard', format = 'bullet', tone = 'professional', language = 'english' } = req.body;

        if (!content) {
            return res.status(400).json({ error: 'Content is required' });
        }

        // Note length instructions
        const lengthGuides = {
            brief: 'Be VERY concise. Maximum 5-6 bullet points. Focus only on the most critical information. Skip minor details.',
            standard: 'Be comprehensive but clear. Include all key points with moderate detail. Aim for 8-12 bullet points.',
            detailed: 'Be thorough and in-depth. Include all information with explanations. Provide context and examples where helpful. Aim for 15+ bullet points.',
        };

        const lengthInstruction = lengthGuides[noteLength] || lengthGuides.standard;

        // Format instructions
        const formatGuides = {
            bullet: 'Use standard bullet points with clear hierarchy.',
            meeting: 'Format as meeting minutes: structured with Attendees, Agenda, Discussion Points, Decisions made, and Action Items.',
            study: 'Format as a study guide: Definitions, Key Concepts, Summaries, and Review Questions.',
            todo: 'Format as a To-Do list: prioritized tasks, clear checkboxes, and deadlines/timeframes if implied.',
            summary: 'Format as an executive summary: High-level overview, key findings, and strategic recommendations. Paragraph form.',
            blog: 'Format as a structured blog post skeleton: Catchy Title, Introduction, clearly headed Body Paragraphs, and Conclusion.',
        };
        const formatInstruction = formatGuides[format] || formatGuides.bullet;

        // Tone instructions
        const toneGuides = {
            professional: 'Use professional, business-appropriate language.',
            academic: 'Use formal, academic language suitable for research or study.',
            casual: 'Use relaxed, easy-to-understand language.',
            creative: 'Use engaging, descriptive, and creative language.',
        };
        const toneInstruction = toneGuides[tone] || toneGuides.professional;

        // Language instruction
        const languageInstruction = language && language.toLowerCase() !== 'english'
            ? `IMPORTANT: Generate ALL content in ${language}. Provide the SAME level of detail and number of points as you would in English. Do NOT shorten or summarize when translating. Use natural ${language} phrasing.`
            : 'Keep the output in English.';

        let prompt = '';
        let result;

        switch (type) {
            case 'text':
                prompt = `You are an expert note-taking assistant. Transform the following content into perfectly organized, professional notes.

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
3. Use bullet points (•) for lists, not dashes
4. Bold important terms by surrounding them with **asterisks**
5. Add a "📌 Key Takeaways" section at the end

FORMAT YOUR RESPONSE AS:
# Appropriate Title Based on Content

• Section headers in bold
• Organized content with bullet points
• Sub-points indented properly

## Key Takeaways
• Most important point 1
• Most important point 2
• Most important point 3

Generate the notes now:`;

                const textModel = getModel();
                result = await generateWithRetry(textModel, prompt);
                break;

            case 'image':
                prompt = `You are an expert at analyzing images and extracting information. Analyze this image thoroughly and create comprehensive notes.

LENGTH REQUIREMENT: ${lengthInstruction}
FORMAT REQUIREMENT: ${formatInstruction}
TONE REQUIREMENT: ${toneInstruction}
LANGUAGE REQUIREMENT: ${languageInstruction}

INSTRUCTIONS:
1. If it contains text/handwriting: Transcribe it accurately and organize it
2. If it's a diagram/chart: Explain what it shows and extract all data
3. If it's a photo of notes/whiteboard: Clean up and organize the content
4. If it's any other image: Describe it and note key observations
5. Apply the requested Tone, Format, and Language settings.

FORMAT YOUR RESPONSE AS:
📷 **Image Analysis Notes**

**What This Shows:**
[Brief description]

**Extracted Content:**
• [Organized bullet points of all information]

📌 **Key Points**
• [Important observations]

Generate the notes now following all requirements:`;

                const visionModel = getModel();
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
                prompt = `You are an expert transcriber and note-taker. Transcribe this audio and convert it into organized, professional notes.

LENGTH REQUIREMENT: ${lengthInstruction}
FORMAT REQUIREMENT: ${formatInstruction}
TONE REQUIREMENT: ${toneInstruction}
LANGUAGE REQUIREMENT: ${languageInstruction}

INSTRUCTIONS:
1. First, transcribe the spoken content accurately
2. Clean up filler words (um, uh, like, you know)
3. Organize by topics/themes mentioned
4. Extract action items if any are mentioned
5. Highlight important names, dates, numbers
6. Apply the requested Tone, Format, and Language settings.

FORMAT YOUR RESPONSE AS:
🎙️ **Audio Notes**

**Summary:**
[2-3 sentence summary of what was discussed]

**Detailed Notes:**
• [Organized content by topic]

📌 **Key Points & Action Items**
• [Important takeaways]

Generate the notes now following all requirements:`;

                const audioModel = getModel();

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
                prompt = `The user has uploaded a PDF file named: "${content}"

Since I cannot read the PDF content directly, provide a professional note-taking template they can use.

LENGTH REQUIREMENT: ${lengthInstruction}
FORMAT REQUIREMENT: ${formatInstruction}
TONE REQUIREMENT: ${toneInstruction}
LANGUAGE REQUIREMENT: ${languageInstruction}

INSTRUCTIONS:

📄 **Notes Template for: ${content}**

**Document Overview**
• Title: Document title here
• Date: Date if applicable
• Type: Report/Article/Manual/etc.

**Main Content**

Section 1: Topic
• Key point here
• Key point here

Section 2: Topic
• Key point here
• Key point here

**Key Takeaways**
• Most important point 1
• Most important point 2
• Most important point 3

**Action Items**
• Task 1
• Task 2

**Additional Notes**
Space for extra observations

---
Fill in this template as you review your PDF!
(Note: Since I cannot read the PDF directly, I have provided a template. If you can copy the text from the PDF and paste it as text input, I can generate specific notes for you!)`;

                const pdfModel = getModel();
                result = await generateWithRetry(pdfModel, prompt);
                break;

            case 'website':
                const websiteText = await fetchWebsiteContent(content);
                prompt = `You are an expert web researcher. Summarize the following website content into clear, organized notes.

URL: ${content}

WEBSITE CONTENT:
"""
${websiteText}
"""

LENGTH REQUIREMENT: ${lengthInstruction}
FORMAT REQUIREMENT: ${formatInstruction}
TONE REQUIREMENT: ${toneInstruction}
LANGUAGE REQUIREMENT: ${languageInstruction}

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

                const webModel = getModel();
                result = await generateWithRetry(webModel, prompt);
                break;

            case 'youtube':
                const transcript = await fetchYouTubeTranscript(content);
                prompt = `You are an expert video summarizer. Create detailed notes from this YouTube video transcript.

VIDEO URL: ${content}

TRANSCRIPT:
"""
${transcript}
"""

LENGTH REQUIREMENT: ${lengthInstruction}
FORMAT REQUIREMENT: ${formatInstruction}
TONE REQUIREMENT: ${toneInstruction}
LANGUAGE REQUIREMENT: ${languageInstruction}

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

                const ytModel = getModel();
                result = await generateWithRetry(ytModel, prompt);
                break;

            default:
                return res.status(400).json({ error: 'Invalid input type' });
        }

        const notes = result.response.text();
        res.json({ notes });

    } catch (error) {
        console.error('Notes generation error:', error);
        res.status(500).json({ error: 'Failed to generate notes', details: error.message });
    }
});

// ==================== REPLY ENDPOINT ====================
app.post('/api/reply', async (req, res) => {
    try {
        const { message, tone, style, format, mode = 'reply', language = 'English' } = req.body;

        if (!message) {
            return res.status(400).json({ error: 'Message is required' });
        }

        // ... keys ...

        let prompt;

        if (mode === 'refine') {
            // STRICT REFINE MODE
            prompt = `You are an expert editor and translator. Rewrite/Refine the user's draft message.

USER'S DRAFT:
"""
${message}
"""

TARGET REQUIREMENTS:
• Tone: ${toneGuides[tone] || toneGuides.professional}
• Style: ${styleGuides[style] || styleGuides.short}
• Format: ${formatGuides[format] || formatGuides.email}
• Output Language: ${language}

IMPORTANT RULES:
1. Do NOT reply to the message. You must REWRITE it.
2. Keep the original meaning but change the wording/tone.
3. Write as a NATIVE speaker of ${language}. Do not use literal translations.
4. If the target language is different from input, TRANSLATE + REFINE simultaneously to sound natural.
5. Generate 3 distinct versions.
6. Each version must be COMPLETE.
7. Separate strictly with: ---REPLY---

Generate 3 refined versions now:`;

        } else if (mode === 'compose') {
            // STRICT COMPOSE MODE
            prompt = `You are an expert writer and translator. Write a message based on the user's topic/instruction.

USER'S TOPIC/INSTRUCTION:
"""
${message}
"""

TARGET REQUIREMENTS:
• Tone: ${toneGuides[tone] || toneGuides.professional}
• Style: ${styleGuides[style] || styleGuides.short}
• Format: ${formatGuides[format] || formatGuides.email}
• Output Language: ${language}

IMPORTANT RULES:
1. Write a NEW message about this topic in ${language}.
2. Expand on the instruction to make it a complete message.
3. Write as a NATIVE speaker of ${language}.
4. Generate 3 distinct versions.
5. Each version must be COMPLETE.
6. Separate strictly with: ---REPLY---

Generate 3 versions now:`;

        } else {
            // STRICT REPLY MODE (Default)
            prompt = `You are an expert communication assistant. Generate a reply TO the message below.

RECEIVED MESSAGE:
"""
${message}
"""

REPLY REQUIREMENTS:
• Tone: ${toneGuides[tone] || toneGuides.professional}
• Style: ${styleGuides[style] || styleGuides.short}
• Format: ${formatGuides[format] || formatGuides.email}
• Output Language: ${language}

IMPORTANT RULES:
1. You are engaging in conversation. Reply TO what was said.
2. Answer in ${language} regardless of the input language.
3. Write as a NATIVE speaker of ${language}.
4. Don't simply rewrite the message. Answer it.
5. Generate 3 distinct options.
6. Each option must be COMPLETE.
7. Separate strictly with: ---REPLY---

Generate 3 replies now:`;
        }

        const model = getModel();
        const result = await generateWithRetry(model, prompt);
        const responseText = result.response.text();

        // Split the response into separate replies
        let replies = responseText.split('---REPLY---')
            .map(reply => reply.trim())
            .filter(reply => reply.length > 0);

        // If splitting didn't work well, try other patterns
        if (replies.length < 3) {
            replies = responseText.split(/\n\n(?=(?:Hi|Hello|Dear|Hey|Thank|I ))/i)
                .map(reply => reply.trim())
                .filter(reply => reply.length > 15);
        }

        // Clean up any remaining markers
        replies = replies.map(reply =>
            reply.replace(/^(Reply\s*\d+:?|Option\s*\d+:?|\d+\.)/i, '').trim()
        );

        // Ensure we have 3 replies
        while (replies.length < 3) {
            replies.push(replies[0] || 'Sorry, I couldn\'t generate a reply. Please try again.');
        }

        // Take only first 3
        replies = replies.slice(0, 3);

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

        // Create new user
        const user = new User({
            recoveryCode,
            credits: 0,
            freeCreditsRemaining: 5,
        });

        await user.save();

        res.json({
            success: true,
            recoveryCode,
            credits: user.credits,
            freeCreditsRemaining: user.freeCreditsRemaining,
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

        // Reset daily free credits if needed
        const wasReset = user.resetDailyCreditsIfNeeded();
        if (wasReset) {
            await user.save();
        }

        // Update last active
        user.lastActive = new Date();
        await user.save();

        res.json({
            success: true,
            credits: user.credits,
            freeCreditsRemaining: user.freeCreditsRemaining,
            totalAvailable: user.credits + user.freeCreditsRemaining,
        });
    } catch (error) {
        console.error('Balance error:', error);
        res.status(500).json({ error: 'Failed to get balance', details: error.message });
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
        user.resetDailyCreditsIfNeeded();

        const totalAvailable = user.credits + user.freeCreditsRemaining;

        if (totalAvailable < amount) {
            return res.status(400).json({
                error: 'Insufficient credits',
                available: totalAvailable,
                required: amount,
            });
        }

        // Use free credits first, then purchased credits
        let remaining = amount;
        if (user.freeCreditsRemaining >= remaining) {
            user.freeCreditsRemaining -= remaining;
        } else {
            remaining -= user.freeCreditsRemaining;
            user.freeCreditsRemaining = 0;
            user.credits -= remaining;
        }

        user.lastActive = new Date();
        await user.save();

        res.json({
            success: true,
            creditsUsed: amount,
            remainingCredits: user.credits,
            remainingFreeCredits: user.freeCreditsRemaining,
            totalAvailable: user.credits + user.freeCreditsRemaining,
        });
    } catch (error) {
        console.error('Use credits error:', error);
        res.status(500).json({ error: 'Failed to use credits', details: error.message });
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
            targetAccount.resetDailyCreditsIfNeeded();
            targetAccount.lastActive = new Date();
            await targetAccount.save();

            return res.json({
                success: true,
                recoveryCode: targetAccount.recoveryCode,
                credits: targetAccount.credits,
                freeCreditsRemaining: targetAccount.freeCreditsRemaining,
                totalAvailable: targetAccount.credits + targetAccount.freeCreditsRemaining,
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

        targetAccount.resetDailyCreditsIfNeeded();
        targetAccount.lastActive = new Date();
        await targetAccount.save();

        res.json({
            success: true,
            recoveryCode: targetAccount.recoveryCode,
            credits: targetAccount.credits,
            freeCreditsRemaining: targetAccount.freeCreditsRemaining,
            totalAvailable: targetAccount.credits + targetAccount.freeCreditsRemaining,
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
