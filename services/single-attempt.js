function createSingleAttempt({ complete, getSignal = () => undefined }) {
    return async (maxTokens, content, onDelta) => {
        require('./smart-note-safety').validateNotePrompt(content);
        const signal = getSignal();
        signal?.throwIfAborted();
        // One paid attempt. Existing billing middleware returns credits on failure.
        return complete(content, maxTokens, signal, onDelta);
    };
}
module.exports = { createSingleAttempt };
