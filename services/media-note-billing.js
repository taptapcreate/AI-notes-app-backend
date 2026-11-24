const { PDFDocument } = require('pdf-lib');
const { CreditError } = require('./credit-policy');
const { validateImageBatch } = require('./image-attachments');

function generationMediaPricing(config) {
    const overrides = config?.generationMediaPricing;
    const rate = (key, fallback, max) => {
        const value = overrides?.[key] ?? fallback;
        if (!Number.isSafeInteger(value) || value < 1 || value > max)
            throw new CreditError(503, 'Media credit pricing is temporarily unavailable.');
        return value;
    };
    const audioExtra = rate('audioExtra', 1, 5);
    const audioLongExtra = rate('audioLongExtra', audioExtra + 1, 6);
    if (audioLongExtra <= audioExtra)
        throw new CreditError(503, 'Media credit pricing is temporarily unavailable.');
    return {
        audioExtra,
        audioLongExtra,
        narrationExtra: rate('narrationExtra', 1, 5),
        pdfPagesPerCredit: rate('pdfPagesPerCredit', 3, 10),
    };
}

function validatePCM(value, seconds) {
    const label = seconds === 60 ? '60 seconds' : `${seconds / 60} minutes`;
    const error = new CreditError(400, `Choose an audio recording of ${label} or less.`);
    if (typeof value !== 'string' || value.length > Math.ceil((44 + seconds * 32000) / 3) * 4 ||
        value.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw error;
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
    return length / 32000;
}

function isPreparedPCM(value) {
    if (typeof value !== 'string' || !value.startsWith('UklGR')) return false;
    const header = Buffer.from(value.slice(0, 60), 'base64');
    return header.length >= 44 && header.toString('ascii', 8, 16) === 'WAVEfmt ' &&
        header.readUInt32LE(16) === 16 && header.readUInt16LE(20) === 1 &&
        header.readUInt16LE(22) === 1 && header.readUInt32LE(24) === 16000 &&
        header.readUInt32LE(28) === 32000 && header.readUInt16LE(32) === 2 &&
        header.readUInt16LE(34) === 16 && header.toString('ascii', 36, 40) === 'data';
}

function validatePdfEvidence(endpoint, body) {
    if (body.pdfEvidence === undefined) return;
    const invalid = () => new CreditError(400, 'Choose valid local and cloud PDF pages.');
    if (endpoint !== '/notes' || body.type !== 'pdf' ||
        !((body.desktopMediaBilling === 1 && body.mobileMediaBilling === undefined) ||
            (body.mobileMediaBilling === 1 && body.desktopMediaBilling === undefined)) ||
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
    try {
        const suggestions = require('./book-suggestions').suggestionContext(body);
        if (suggestions) {
            if (endpoint !== '/notes') throw Error('Book suggestions require the notes endpoint.');
            return suggestions.cost;
        }
    } catch (error) { throw new CreditError(400, error.message); }
    validatePdfEvidence(endpoint, body);
    validateImageBatch(body);
    const desktop = body.desktopMediaBilling !== undefined;
    const mobile = body.mobileMediaBilling !== undefined;
    if (body.additionalImages !== undefined &&
        (body.desktopMediaBilling !== 1 || mobile || body.mediaCreditQuote === undefined))
        throw new CreditError(426, 'Update AI Notes to use image-batch credit pricing.');
    const pcmDuration = body.type === 'voice' && (desktop || (!mobile && isPreparedPCM(body.content)))
        ? validatePCM(body.content, 300) : null;
    if (pcmDuration > 180 && (body.desktopMediaBilling !== 1 || body.mediaCreditQuote === undefined))
        throw new CreditError(426, 'Update AI Notes to use recordings longer than 3 minutes.');
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
    if (body.additionalImages !== undefined)
        return verifyQuote(1 + Math.ceil(body.additionalImages.length / 2));
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
        if (!desktop && Buffer.byteLength(body.content, 'base64') > 15 * 1024 * 1024)
            throw new CreditError(400, 'Choose an audio file up to 15 MB.');
        return verifyQuote(1 + (desktop && pcmDuration > 180 ? pricing.audioLongExtra : pricing.audioExtra));
    }
    if (desktop && body.sourceKind === 'walkthrough' && body.narration) {
        validatePCM(body.narration, 60);
        return verifyQuote(1 + pricing.narrationExtra);
    }
    throw new CreditError(400, 'Unsupported media billing request');
}
module.exports = { generationUnits, generationMediaPricing };
