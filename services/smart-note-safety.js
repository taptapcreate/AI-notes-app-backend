const { CreditError } = require('./credit-policy');
// Byte limits are conservative and language-independent; they are not token estimates.
const sourceBytes = 24000;
const instructionBytes = 4000;
const promptBytes = 32000;
const bytes = (value) =>
    typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : 0;
const tooLarge = () =>
    new CreditError(
        413,
        'This source is too large for one note. Select fewer pages or a shorter passage. Your credits have not been charged.',
        { code: 'NOTE_SOURCE_TOO_LARGE' },
    );
function validateNoteSource(endpoint, body) {
    if (body.bookSuggestionsVersion === 1 || body.writingReviewVersion === 1)
        return;
    if (bytes(body.instruction) > instructionBytes) throw tooLarge();
    const fields =
        endpoint === '/notes'
            ? body.type === 'text'
                ? ['content']
                : []
            : endpoint === '/followup'
              ? ['context', 'question']
              : endpoint === '/reply' || endpoint === '/sentiment'
                ? ['message', 'text', 'attachmentText']
                : ['text'];
    if (
        fields.reduce(
            (sum, key) =>
                sum + (body[key] ? bytes(JSON.stringify(body[key])) : 0),
            0,
        ) > sourceBytes
    )
        throw tooLarge();
    if (
        body.pdfEvidence &&
        bytes(JSON.stringify(body.pdfEvidence.localPages)) > sourceBytes
    )
        throw tooLarge();
}
function validateNotePrompt(content) {
    const text =
        typeof content === 'string'
            ? content
            : content.filter((item) => typeof item === 'string').join('\n');
    if (bytes(text) > promptBytes) throw tooLarge();
}
module.exports = {
    sourceBytes,
    instructionBytes,
    promptBytes,
    validateNoteSource,
    validateNotePrompt,
};
