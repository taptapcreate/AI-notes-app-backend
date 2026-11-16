const { PDFDocument } = require('pdf-lib');
const { CreditError } = require('./credit-policy');

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

async function generationUnits(endpoint, body) {
    const desktop = body.desktopMediaBilling !== undefined;
    const mobile = body.mobileMediaBilling !== undefined;
    if (!desktop && !mobile) return 1;
    if (endpoint !== '/notes' || (desktop && mobile) || (body.desktopMediaBilling ?? body.mobileMediaBilling) !== 1)
        throw new CreditError(400, 'Invalid media billing request');
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
        return 2;
    }
    if (body.type === 'voice') {
        if (desktop) validatePCM(body.content, 180);
        else if (Buffer.byteLength(body.content, 'base64') > 15 * 1024 * 1024)
            throw new CreditError(400, 'Choose an audio file up to 15 MB.');
        return 2;
    }
    if (desktop && body.sourceKind === 'walkthrough' && body.narration) {
        validatePCM(body.narration, 60);
        return 2;
    }
    throw new CreditError(400, 'Unsupported media billing request');
}
module.exports = { generationUnits };
