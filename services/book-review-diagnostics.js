// Intentionally exclude messages, prompts, response text, titles and account identifiers.
const reasons = new Set([
    'segment_shift', 'neighbor_text_copy', 'boundary_duplicate_words',
    'split_continuation_changed', 'dangling_fragment', 'connecting_word_dropped',
    'response_not_text', 'invalid_json', 'edits_not_array', 'too_many_edits',
    'unknown_segment_id', 'duplicate_segment_id', 'edit_not_text', 'empty_edit',
    'edit_too_long', 'line_break_mismatch', 'passage_omission',
    'dialogue_punctuation_removed', 'chapter_omission', 'chapter_size_limit',
]);
const stages = new Set(['batch', 'repair', 'checkpoint', 'final']);
const measurements = [
    'editCount', 'segmentCount', 'sourceChars', 'replacementChars',
    'sourceLineBreaks', 'replacementLineBreaks',
    'responseChars', 'parseOffset', 'endsWithBrace',
];
const safeEnums = {
    startsWith: new Set(['empty', 'brace', 'bracket', 'fence', 'other']),
    syntaxErrorKind: new Set(['unexpected_end', 'unterminated_string', 'bad_escape', 'unexpected_token', 'other']),
    finishReason: new Set(['stop', 'length', 'content_filter', 'error', 'other']),
};
function reviewDiagnostic(error, stage, batchIndex, attempt) {
    const details = error?.reviewValidation || {};
    const diagnostic = {
        stage: stages.has(stage) ? stage : 'batch',
        reason: reasons.has(details.reason) ? details.reason : 'unclassified_validation',
    };
    if (Number.isSafeInteger(batchIndex) && batchIndex >= 0) diagnostic.batchIndex = batchIndex;
    if (Number.isSafeInteger(attempt) && attempt > 0) diagnostic.attempt = attempt;
    // Unknown model-supplied IDs can contain arbitrary text. Log only source-shaped IDs.
    diagnostic.segmentIds = Array.isArray(error?.segmentIds)
        ? error.segmentIds.filter(id => typeof id === 'string' && /^s\d{1,4}$/.test(id)).slice(0, 4)
        : [];
    for (const key of measurements)
        if (Number.isSafeInteger(details[key]) && details[key] >= 0) diagnostic[key] = details[key];
    for (const [key, allowed] of Object.entries(safeEnums))
        if (typeof details[key] === 'string' && allowed.has(details[key])) diagnostic[key] = details[key];
    return diagnostic;
}
module.exports = { reviewDiagnostic };
