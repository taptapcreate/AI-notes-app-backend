const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const testEmptyTranscript = async () => {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

    const content = "https://youtu.be/YoHD9XEInc0?si=Y3lShBCB80MK8h-v";
    const transcript = ""; // Empty transcript

    const prompt = `You are an expert video summarizer. Create detailed notes from this YouTube video transcript.

VIDEO URL: ${content}

TRANSCRIPT:
"""
${transcript}
"""

LENGTH REQUIREMENT: Be comprehensive but clear. Include all key points with moderate detail. Aim for 8-12 bullet points.
FORMAT REQUIREMENT: Use standard bullet points with clear hierarchy.
TONE REQUIREMENT: Use professional, business-appropriate language.
LANGUAGE REQUIREMENT: Keep the output in English.

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

    try {
        const result = await model.generateContent(prompt);
        console.log("Response text:");
        console.log(result.response.text());
    } catch (e) {
        console.error("Error:", e);
    }
};

testEmptyTranscript();
