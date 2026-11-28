function replyDetail(value, analysis = false) {
    const length = typeof value === 'string' ? value.toLowerCase() : 'standard';
    const level = ['brief', 'standard', 'detailed'].includes(length) ? length : 'standard';
    const prose = {
        brief: 'Keep each option focused and complete, usually 35–65 words when supported by the source.',
        standard: 'Develop each option with useful context and a practical next step, usually 70–110 words.',
        detailed: 'Give each option fuller coverage of relevant questions, supported context and practical next steps, usually 120–180 words in organized paragraphs.',
    };
    const review = {
        brief: 'Give a short, useful explanation of the main request or wording issue and any material ambiguity, usually 60–100 words when supported by the source.',
        standard: 'Explain the supported context, explicit requests and important nuance. Explain why each observation matters and suggest practical clarifications, usually 150–250 words when the source supports this.',
        detailed: 'Develop a thorough analysis of the supported context. For each important observation, explain the evidence in the message, its possible practical implication and a useful clarification or improvement. Use multiple explanatory sentences where useful, aiming for roughly 250–450 words when the message provides enough material.',
    };
    return {
        instruction: (analysis ? review[level] : prose[level]) +
            ' Scale to the source and channel; respect actual character limits and explicit user length limits. The selected detail level controls coverage; writing style controls phrasing. A short style means direct wording rather than omitting important points. The word ranges are guides, not quotas. Do not add filler, invent facts, hidden intentions, commitments or deadlines.',
        maxTokens: level === 'detailed' ? (analysis ? 3072 : 4096) : 2048,
    };
}
module.exports = { replyDetail };
