const { GoogleGenerativeAI } = require("@google/generative-ai");
require('dotenv').config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function listModels() {
    try {
        console.log("Checking available models for your API key...");
        // This is a dummy call to see what happens or if we can list
        // Note: The SDK doesn't have a direct 'listModels' easily, but we can try a simple generation on 1.0 Pro as a test

        const models = [
            'gemini-1.5-flash',
            'gemini-1.5-flash-latest',
            'gemini-1.5-flash-001',
            'gemini-1.5-flash-002',
            'gemini-2.0-flash',
            'gemini-1.0-pro'
        ];

        for (const modelName of models) {
            try {
                const model = genAI.getGenerativeModel({ model: modelName });
                const result = await model.generateContent("Hi");
                console.log(`✅ [SUCCESS] ${modelName} is available.`);
            } catch (err) {
                console.log(`❌ [FAILED]  ${modelName}: ${err.message}`);
            }
        }
    } catch (error) {
        console.error("Critical Error:", error);
    }
}

listModels();
