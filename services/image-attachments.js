const { CreditError } = require('./credit-policy');
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_IMAGE_EDGE = 2048;

function jpegDimensions(data) {
    if (data[0] !== 0xff || data[1] !== 0xd8) return null;
    let offset = 2;
    while (offset + 4 <= data.length) {
        if (data[offset++] !== 0xff) return null;
        while (data[offset] === 0xff) offset++;
        const marker = data[offset++];
        if (marker === 0xda || marker === 0xd9) return null;
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
        if (offset + 2 > data.length) return null;
        const size = data.readUInt16BE(offset);
        if (size < 2 || offset + size > data.length) return null;
        if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
            if (size < 8) return null;
            return { height: data.readUInt16BE(offset + 3), width: data.readUInt16BE(offset + 5) };
        }
        offset += size;
    }
    return null;
}

function validateImageBatch(body) {
    if (body.additionalImages === undefined) return;
    if (body.type !== 'image' || body.sourceKind !== 'image' || body.narration !== undefined ||
        !Array.isArray(body.additionalImages) || body.additionalImages.length < 1 || body.additionalImages.length > 4)
        throw new CreditError(400, 'Choose between one and five images for an image note.');
    let total = 0;
    for (const image of [body.content, ...body.additionalImages]) {
        if (typeof image !== 'string' || !image.length || image.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
            image.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image))
            throw new CreditError(400, 'Choose readable images and try again.');
        const data = Buffer.from(image, 'base64');
        total += data.length;
        if (total > MAX_IMAGE_BYTES) throw new CreditError(413, 'These images exceed 15 MB after preparation. Choose fewer images.');
        const dimensions = jpegDimensions(data);
        if (!dimensions || !dimensions.width || !dimensions.height ||
            Math.max(dimensions.width, dimensions.height) > MAX_IMAGE_EDGE)
            throw new CreditError(400, 'Prepare JPEG images with a longest side of 2,048 pixels or less.');
    }
}

function noteImageParts(body) {
    return [body.content, ...(body.additionalImages || [])].map(data => ({
        inlineData: { mimeType: body.type === 'pdf' ? 'application/pdf' : 'image/jpeg', data },
    }));
}

module.exports = { validateImageBatch, noteImageParts };
