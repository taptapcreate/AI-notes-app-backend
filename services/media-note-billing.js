const { PDFDocument } = require('pdf-lib');
const { CreditError } = require('./credit-policy');

function generationMediaPricing(config) {
    const overrides = config?.generationMediaPricing;
    const rate = (key, fallback, max) => {
        const value = overrides?.[key] ?? fallback;
        if (!Number.isSafeInteger(value) || value < 1 || value > max)
            throw new CreditError(503, 'Media credit pricing is temporarily unavailable.');
        return value;
    };
    return {
        audioExtra: rate('audioExtra', 1, 5),
        narrationExtra: rate('narrationExtra', 1, 5),
        pdfPagesPerCredit: rate('pdfPagesPerCredit', 3, 10),
    };
}

function validatePCM(value, seconds) {
    const error = new CreditError(400, `Choose an audio recording of ${seconds === 60 ? '60 seconds' : '3 minutes'} or less.`);
    const data = Buffer.from(value, 'base64');
    const length = data.length - 44;
    // The desktop encodes 16 kHz, mono, signed 16-bit PCM with a single data chunk.
    if (length <= 0 || length % 2 || length > seconds * 32000 ||
        data.toString('ascii', 0, 4) !== 'RIFF' ||
        data.readUInt32LE(4) !== data.length - 8 ||
        data.toString('ascii', 8, 16) !== 'WAVEfmt ' ||
        data.readUInt32LE(16) !== 16 || data.readUInt16LE(20) !== 1 ||
        data.readUInt16LE(22) !== 1 || data.readUInt32LE(24) !== 16000 ||
        data.readUInt32LE(28) !== 32000 || data.readUInt16LE(32) !== 2 ||
        data.readUInt16LE(34) !== 16 || data.toString('ascii', 36, 40) !== 'data' ||
        data.readUInt32LE(40) !== length) throw error;
}

function validatePdfEvidence(endpoint, body) {
    if (body.pdfEvidence === undefined) return;
    const invalid = () => new CreditError(400, 'Choose valid local and cloud PDF pages.');
    if (endpoint !== '/notes' || body.type !== 'pdf' ||
        body.desktopMediaBilling !== 1 || body.mobileMediaBilling !== undefined ||
        body.pdfOcrCreditQuote === undefined || !body.pdfEvidence ||
        typeof body.pdfEvidence !== 'object' || Array.isArray(body.pdfEvidence))
        throw invalid();
    const { localPages, cloudPages } = body.pdfEvidence;
    if (!Array.isArray(localPages) || !Array.isArray(cloudPages) || !localPages.length ||
        !cloudPages.length || localPages.length + cloudPages.length > 10 ||
        localPages.some(entry => !entry || typeof entry.text !== 'string' ||
            !entry.text.trim() || entry.text.length > 20000))
        throw invalid();
    const pages = [...localPages.map(entry => entry.page), ...cloudPages];
    if (pages.some(page => !Number.isSafeInteger(page) || page < 1) ||
        new Set(pages).size !== pages.length ||
        cloudPages.some((page, index) => index > 0 && page <= cloudPages[index - 1]))
        throw invalid();
}

async function generationUnits(endpoint, body, config) {
    validatePdfEvidence(endpoint, body);
    const desktop = body.desktopMediaBilling !== undefined;
    const mobile = body.mobileMediaBilling !== undefined;
    if (body.mediaCreditQuote !== undefined &&
        (endpoint !== '/notes' || (!desktop && !mobile) || body.type === 'pdf' ||
            !Number.isSafeInteger(body.mediaCreditQuote)))
        throw new CreditError(400, 'Invalid media credit estimate.');
    if (body.pdfOcrCreditQuote !== undefined && (endpoint !== '/notes' || body.type !== 'pdf'))
        throw new CreditError(400, 'An OCR quote requires a PDF.');
    if (!desktop && !mobile && body.type === 'pdf' && endpoint === '/notes')
        throw new CreditError(426, 'Update AI Notes to use PDF text recognition.');
    if (!desktop && !mobile) return 1;
    if (endpoint !== '/notes' || (desktop && mobile) || (body.desktopMediaBilling ?? body.mobileMediaBilling) !== 1)
        throw new CreditError(400, 'Invalid media billing request');
    const pricing = generationMediaPricing(config);
    const verifyQuote = (units) => {
        if (body.mediaCreditQuote !== undefined && body.mediaCreditQuote !== units)
            throw new CreditError(409, `This media needs ${units} AI credits. Refresh the estimate and try again.`,
                { code: 'CREDIT_QUOTE_CHANGED' });
        return units;
    };
    if (body.type === 'pdf') {
        let pages;
        try {
            const bytes = Buffer.from(body.content, 'base64');
            if (bytes.length > 15 * 1024 * 1024 || !bytes.subarray(0, 1024).includes('%PDF-'))
                throw new Error('Invalid PDF');
            pages = (await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true })).getPageCount();
        } catch {
            throw new CreditError(400, 'Choose a readable, unlocked PDF.');
        }
        if (pages < 1 || pages > 10) throw new CreditError(400, 'Choose a PDF with 1 to 10 pages.');
        if (body.pdfEvidence && body.pdfEvidence.cloudPages.length !== pages)
            throw new CreditError(400, 'The cloud page list does not match the PDF attachment.');
        const units = 1 + Math.ceil(pages / pricing.pdfPagesPerCredit);
        if (body.pdfOcrCreditQuote === undefined && pages > 3)
            throw new CreditError(426, 'Update AI Notes to process more than 3 scanned PDF pages.');
        if (body.pdfOcrCreditQuote !== undefined && body.pdfOcrCreditQuote !== units)
            throw new CreditError(409, `These PDF pages need ${units} AI credits. Review your selection and try again.`,
                { code: 'CREDIT_QUOTE_CHANGED' });
        return units;
    }
    if (body.type === 'voice') {
        if (desktop) validatePCM(body.content, 180);
        else if (Buffer.byteLength(body.content, 'base64') > 15 * 1024 * 1024)
            throw new CreditError(400, 'Choose an audio file up to 15 MB.');
        return verifyQuote(1 + pricing.audioExtra);
    }
    if (desktop && body.sourceKind === 'walkthrough' && body.narration) {
        validatePCM(body.narration, 60);
        return verifyQuote(1 + pricing.narrationExtra);
    }
    throw new CreditError(400, 'Unsupported media billing request');
}
module.exports = { generationUnits, generationMediaPricing };
