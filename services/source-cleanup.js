const cheerio = require('cheerio');
// Preserve code indentation, meaningful repetition, Markdown and Unicode in user material.
function cleanSourceText(value) {
    return String(value ?? '').replace(/^\uFEFF/, '').replace(/\0/g, '').replace(/\r\n?/g, '\n').replace(/^(?:[ \t]*\n)+|(?:\n[ \t]*)+$/g, '');
}
function websiteText(html, { plainText = false, limit = 10000 } = {}) {
    if (plainText) return cleanSourceText(html).slice(0, limit);
    const $ = cheerio.load(html);
    $('script,style,noscript,template,nav,footer,[role="navigation"],[role="banner"],.ads,.advertisement,[aria-hidden="true"],.cookie-banner,#cookie-banner').remove();
    const robots = $('meta[name="robots"]').attr('content') || '';
    const title = $('title').text();
    if (robots.split(/[\s,]+/i).some(token => token.toLowerCase() === 'noai') ||
        /just a moment|access denied|verify (?:that )?you are human|attention required/i.test(title)) {
        throw new Error('Restricted page');
    }
    const main = $('main,[role="main"]').first();
    const articles = $('article');
    const primary = main.length ? main : articles.length === 1 ? articles : null;
    const root = primary && primary.text().trim().length >= 80 ? primary : $('body');
    const seen = new Set();
    const blocks = [];
    root.find('h1,h2,h3,h4,h5,h6,p,li,pre,table').each((_index, el) => {
        const node = $(el);
        if (node.parents('pre,table').length) return;
        let text;
        if (el.tagName === 'table') {
            text = node.find('tr').map((_i,row) => $(row).find('th,td').map((_j,cell) => $(cell).text().replace(/\s+/g,' ').trim()).get().join(' | ')).get().join('\n');
        } else {
            const copy = node.clone();
            copy.find('h1,h2,h3,h4,h5,h6,p,li,pre,table').remove();
            text = copy.text();
        }
        text = cleanSourceText(text);
        if (el.tagName !== 'pre') text = text.replace(/[^\S\n]+/g, ' ');
        // Boilerplate duplicates only; do not deduplicate free-form user text or code.
        if (!text || (el.tagName !== 'pre' && seen.has(text))) return;
        seen.add(text);
        blocks.push(text);
    });
    return cleanSourceText(blocks.length ? blocks.join('\n\n') : root.text()).slice(0, limit);
}
module.exports = { cleanSourceText, websiteText };
