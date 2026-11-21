// Keep the complete parsed file, including visual evidence; text-only reuse could lose charts.
// A request with multiple files or conflicting annotations deliberately isn't cached.
function reusablePdfAnnotations(items) {
    if (!Array.isArray(items)) return null;
    const files = items.filter(item => item?.type === 'file');
    if (files.length !== 1) return null;
    const file = files[0].file;
    if (typeof file?.hash !== 'string' || !file.hash || file.hash.length > 512 ||
        !Array.isArray(file.content) || !file.content.length || file.content.length > 10000 ||
        file.content.some(part => part?.type === 'text' ? typeof part.text !== 'string'
            : part?.type !== 'image_url' || typeof part.image_url?.url !== 'string' ||
                !/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(part.image_url.url))) return null;
    if (!file.content.some(part => part.type === 'image_url' || part.text.trim())) return null;
    let size = 0;
    for (const part of file.content) {
        size += Buffer.byteLength(part.type === 'text' ? part.text : part.image_url.url);
        if (size > 2 * 1024 * 1024) return null;
    }
    // Preserve the documented parse fields, without retaining unrelated provider metadata.
    return [{ type: 'file', file: {
        hash: file.hash,
        ...(typeof file.name === 'string' && file.name.length <= 512 ? { name: file.name } : {}),
        content: file.content.map(part => part.type === 'text' ? { type: 'text', text: part.text }
            : { type: 'image_url', image_url: { url: part.image_url.url,
                ...(['auto', 'low', 'high'].includes(part.image_url.detail) ? { detail: part.image_url.detail } : {}) } }),
    } }];
}
module.exports = { reusablePdfAnnotations };
