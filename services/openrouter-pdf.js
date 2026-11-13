const MAX_PDF_BYTES = 15 * 1024 * 1024;

class InvalidPdf extends Error {}

function pdfPart(content) {
    if (typeof content !== 'string' || content.length > Math.ceil(MAX_PDF_BYTES / 3) * 4 ||
        content.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(content) ||
        !Buffer.from(content.slice(0, 8), 'base64').subarray(0, 5).equals(Buffer.from('%PDF-'))) {
        throw new InvalidPdf('Choose a valid PDF file up to 15 MB and try again.');
    }

    return {
        type: 'file',
        file: { filename: 'document.pdf', file_data: `data:application/pdf;base64,${content}` },
    };
}

module.exports = { pdfPart, InvalidPdf };
