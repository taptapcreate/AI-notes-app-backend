const { CreditError } = require('./credit-policy');
async function audioDuration(content, maxSeconds = 300) {
    const invalid = () =>
        new CreditError(
            400,
            `Choose a readable audio recording of ${maxSeconds / 60} minutes or less.`,
            { code: 'INVALID_AUDIO' },
        );
    if (
        typeof content !== 'string' ||
        content.length % 4 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(content) ||
        content.length > 20 * 1024 * 1024
    )
        throw invalid();
    const { isPreparedPCM, validatePCM } = require('./media-note-billing');
    if (isPreparedPCM(content)) return validatePCM(content, maxSeconds);
    try {
        const { parseBuffer } = await import('music-metadata');
        const { format } = await parseBuffer(
            Buffer.from(content, 'base64'),
            undefined,
            { duration: true, skipCovers: true },
        );
        if (
            !format.codec ||
            !Number.isFinite(format.sampleRate) ||
            format.sampleRate <= 0 ||
            !Number.isFinite(format.duration) ||
            format.duration <= 0 ||
            format.duration > maxSeconds
        )
            throw invalid();
        return format.duration;
    } catch {
        throw invalid();
    }
}
async function prepareNoteImages(body) {
    if (body.type !== 'image') return body;
    const sharp = require('sharp');
    const prepared = [];
    let total = 0;
    for (const content of [body.content, ...(body.additionalImages || [])]) {
        if (
            typeof content !== 'string' ||
            content.length % 4 ||
            !/^[A-Za-z0-9+/]+={0,2}$/.test(content)
        )
            throw new CreditError(
                400,
                'Choose readable JPEG, PNG, WebP or GIF images.',
            );
        const data = Buffer.from(content, 'base64');
        total += data.length;
        if (total > 15 * 1024 * 1024)
            throw new CreditError(
                413,
                'Choose images totalling 15 MB or less.',
            );
        try {
            const image = sharp(data, {
                limitInputPixels: 16000000,
                failOn: 'warning',
                animated: false,
            });
            const meta = await image.metadata();
            if (
                !['jpeg', 'png', 'webp', 'gif'].includes(meta.format) ||
                !meta.width ||
                !meta.height ||
                (meta.pages || 1) > 1
            )
                throw Error('Unsupported image');
            const output = await image
                .rotate()
                .resize({
                    width: 2048,
                    height: 2048,
                    fit: 'inside',
                    withoutEnlargement: true,
                })
                .flatten({ background: '#ffffff' })
                .jpeg({ quality: 90 })
                .toBuffer();
            prepared.push(output.toString('base64'));
        } catch {
            throw new CreditError(
                400,
                'This image could not be read safely. Choose a valid still image and try again.',
                { code: 'INVALID_IMAGE' },
            );
        }
    }
    return {
        ...body,
        content: prepared[0],
        ...(body.additionalImages && { additionalImages: prepared.slice(1) }),
    };
}
module.exports = { audioDuration, prepareNoteImages };

// Detect dense digital documents locally before the paid OCR/model request.
// Scanned pages still use the existing, explicitly quoted cloud-page price.
async function validatePdfSource(content) {
    const { sourceBytes } = require('./smart-note-safety');
    let document, loadingTask;
    try {
        const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
        loadingTask = getDocument({
            data: new Uint8Array(Buffer.from(content, 'base64')),
            standardFontDataUrl: require('node:path').join(
                require('node:path').dirname(
                    require.resolve('pdfjs-dist/package.json'),
                ),
                'standard_fonts/',
            ),
            isEvalSupported: false,
            useSystemFonts: false,
            disableFontFace: true,
            stopAtErrors: true,
        });
        document = await loadingTask.promise;
        if (document.numPages < 1 || document.numPages > 10)
            throw new CreditError(400, 'Choose a PDF with 1 to 10 pages.');
        let total = 0;
        for (let number = 1; number <= document.numPages; number++) {
            const page = await document.getPage(number);
            const view = page.getViewport({ scale: 1 });
            if (view.width > 1440 || view.height > 1440)
                throw new CreditError(
                    400,
                    'Choose PDF pages no larger than 20 inches on either side.',
                );
            const stream = page.streamTextContent();
            const reader = stream.getReader();
            try {
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    for (const item of value.items)
                        total +=
                            typeof item.str === 'string'
                                ? Buffer.byteLength(JSON.stringify(item.str))
                                : 0;
                    if (total > sourceBytes) {
                        await reader.cancel(
                            new Error('PDF source limit reached'),
                        );
                        throw new CreditError(
                            413,
                            'This PDF contains too much text for one note. Select fewer pages. Your credits have not been charged.',
                            { code: 'NOTE_SOURCE_TOO_LARGE' },
                        );
                    }
                }
            } finally {
                reader.releaseLock();
            }
            page.cleanup();
        }
    } catch (error) {
        if (error instanceof CreditError) throw error;
        throw new CreditError(400, 'Choose a readable, unlocked PDF.');
    } finally {
        await loadingTask?.destroy();
    }
}
module.exports.validatePdfSource = validatePdfSource;
