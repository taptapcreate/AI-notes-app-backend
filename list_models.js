require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function listModels() {
    console.log('API Key (first 10 chars):', process.env.GEMINI_API_KEY?.substring(0, 10) + '...');

    try {
        const result = await genAI.listModels();
        console.log('\nAvailable Models:');
        for await (const model of result) {
            if (model.supportedGenerationMethods?.includes('generateContent')) {
                console.log(`- ${model.name}`);
            }
        }
    } catch (error) {
        console.error('Error listing models:', error.message);
    }
}

listModels();
