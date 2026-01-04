const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

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

// ==================== NOTES ENDPOINT ====================
app.post('/api/notes', async (req, res) => {
    try {
        const { type, content, noteLength = 'standard' } = req.body;

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
                result = await textModel.generateContent(prompt);
                break;

            case 'image':
                prompt = `You are an expert at analyzing images and extracting information. Analyze this image thoroughly and create comprehensive notes.

INSTRUCTIONS:
1. If it contains text/handwriting: Transcribe it accurately and organize it
2. If it's a diagram/chart: Explain what it shows and extract all data
3. If it's a photo of notes/whiteboard: Clean up and organize the content
4. If it's any other image: Describe it and note key observations

FORMAT YOUR RESPONSE AS:
📷 **Image Analysis Notes**

**What This Shows:**
[Brief description]

**Extracted Content:**
• [Organized bullet points of all information]

📌 **Key Points**
• [Important observations]

Generate the notes now:`;

                const visionModel = getModel();
                result = await visionModel.generateContent([
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

INSTRUCTIONS:
1. First, transcribe the spoken content accurately
2. Clean up filler words (um, uh, like, you know)
3. Organize by topics/themes mentioned
4. Extract action items if any are mentioned
5. Highlight important names, dates, numbers

FORMAT YOUR RESPONSE AS:
🎙️ **Audio Notes**

**Summary:**
[2-3 sentence summary of what was discussed]

**Detailed Notes:**
• [Organized content by topic]

📌 **Key Points & Action Items**
• [Important takeaways]

Generate the notes now:`;

                const audioModel = getModel();

                // Try different mime types based on what Expo typically records
                // iOS uses .m4a (audio/m4a), Android may use .3gp or .m4a
                let audioMimeType = 'audio/mp4'; // Default fallback

                // Try to detect from content or use common mobile formats
                const supportedMimeTypes = ['audio/mp4', 'audio/m4a', 'audio/mpeg', 'audio/wav'];

                try {
                    result = await audioModel.generateContent([
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

                    result = await audioModel.generateContent(fallbackPrompt);
                }
                break;

            case 'pdf':
                prompt = `The user has uploaded a PDF file named: "${content}"

Since I cannot read the PDF content directly, provide a professional note-taking template they can use.

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
Fill in this template as you review your PDF!`;

                const pdfModel = getModel();
                result = await pdfModel.generateContent(prompt);
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
        const { message, tone, style, format } = req.body;

        if (!message) {
            return res.status(400).json({ error: 'Message is required' });
        }

        const toneGuides = {
            friendly: 'Be warm, personable, use friendly language. Feel free to use exclamation marks and positive words. Show genuine interest.',
            professional: 'Be formal and business-appropriate. Use proper grammar, avoid slang. Be respectful yet confident.',
            casual: 'Be relaxed and conversational. Use natural language, contractions are fine. Keep it light.',
            firm: 'Be assertive and clear. State your position confidently. Be direct but not rude.',
            humorous: 'Add light humor and wit. Keep it fun and entertaining while still being appropriate. Use clever wordplay if suitable.',
            empathetic: 'Show understanding and compassion. Acknowledge their feelings. Be supportive and caring.',
            enthusiastic: 'Be excited and energetic! Show genuine enthusiasm. Use positive, uplifting language.',
            apologetic: 'Express genuine apology and understanding. Take responsibility where appropriate. Offer to make things right.',
            grateful: 'Express sincere thanks and appreciation. Be heartfelt and genuine in your gratitude.',
            confident: 'Be self-assured and decisive. Show expertise and authority without being arrogant.',
        };

        const styleGuides = {
            short: 'Keep it brief - 2-3 sentences maximum. Get straight to the point.',
            detailed: 'Be comprehensive. Explain your reasoning. Address all points mentioned.',
            polite: 'Add extra courtesies. Thank them, wish them well. Be extra considerate.',
            direct: 'No filler or pleasantries. State exactly what you mean clearly.',
            persuasive: 'Craft a convincing message. Use compelling arguments and reasoning to influence their decision.',
            diplomatic: 'Be tactful and balanced. Choose words carefully to avoid conflict while maintaining your position.',
            storytelling: 'Use narrative elements. Share a brief anecdote or example to make your point more relatable.',
            numbered: 'Organize your response with numbered points for clarity and easy reference.',
        };

        const formatGuides = {
            email: `Format as a proper email:
- Start with appropriate greeting (Hi/Hello/Dear based on tone)
- Body paragraph(s)
- Professional sign-off (Best regards/Thanks/Sincerely based on tone)
- Don't include subject line`,
            whatsapp: `Format for WhatsApp/text messaging:
- No formal greeting needed (can use Hey or Hi)
- Keep it conversational
- Use common abbreviations where natural
- Emojis are okay if they fit the tone
- No sign-off needed`,
            letter: `Format as a formal letter:
- Start with "Dear [appropriate title],"
- Proper paragraph structure
- Formal closing like "Sincerely," or "Respectfully,"
- Leave [Your Name] at the end`,
            sms: `Format for SMS/text message:
- Very brief and to the point
- No greeting necessary
- Abbreviations encouraged
- Single short paragraph or a few lines
- No sign-off`,
            linkedin: `Format for LinkedIn message:
- Professional but personable
- Reference their profile/work if relevant
- Clear purpose for reaching out
- Professional closing`,
            twitter: `Format for Twitter/X reply:
- Under 280 characters if possible
- Punchy and engaging
- Can use hashtags if relevant
- Conversational tone`,
            slack: `Format for Slack/Teams message:
- Casual but professional
- Can use emoji reactions
- Clear and scannable
- Use bullet points for multiple items`,
        };

        const prompt = `You are an expert communication assistant. Generate 3 distinct, ready-to-send replies for this message.

ORIGINAL MESSAGE TO REPLY TO:
"""
${message}
"""

REPLY REQUIREMENTS:
• Tone: ${toneGuides[tone] || toneGuides.professional}
• Style: ${styleGuides[style] || styleGuides.short}
• Format: ${formatGuides[format] || formatGuides.email}

IMPORTANT RULES:
1. Each reply must be COMPLETE and ready to copy-paste
2. Each reply should take a slightly different approach/angle
3. Match the tone EXACTLY to what was requested
4. Be contextually aware - understand what they're asking/saying
5. Don't include any labels like "Reply 1:" or explanations
6. Separate each reply with exactly: ---REPLY---

Generate 3 replies now:`;

        const model = getModel();
        const result = await model.generateContent(prompt);
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

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', message: 'AI App Backend is running', version: '1.0.0' });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📝 Notes endpoint: POST /api/notes`);
    console.log(`💬 Reply endpoint: POST /api/reply`);
});
