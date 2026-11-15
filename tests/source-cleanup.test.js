const {test}=require('node:test');
const assert=require('node:assert/strict');
const {cleanSourceText,websiteText}=require('../services/source-cleanup');
test('cleanup preserves code indentation, repeated text, values and Unicode',()=>{
 const source='\uFEFF\r\n    if (x) {\r\n      value = "₹10 👩‍💻";\r\n    }\r\nagain\r\nagain\r\n\0';
 assert.equal(cleanSourceText(source),'    if (x) {\n      value = "₹10 👩‍💻";\n    }\nagain\nagain');
});
test('web extraction removes chrome and duplicates, preserving short headings, table values and code',()=>{
 const html='<nav>Subscribe Menu</nav><p>Sidebar outside main.</p><main><h1>DNA</h1><p>Important research findings with a qualification: estimates are uncertain and the result is 42.</p><p>Repeated useful paragraph.</p><p>Repeated useful paragraph.</p><ul><li>Parent<ul><li>Child</li></ul></li></ul><table><tr><th>Plan</th><th>Limit</th></tr><tr><td>Pro</td><td>10</td></tr></table><pre>    if (x) {\n      x++;\n    }</pre><div class="ads"><p>Buy now</p></div><script>secret()</script></main><footer>Contact us</footer>';
 const result=websiteText(html);assert.match(result,/DNA/);assert.match(result,/uncertain.*42/);assert.match(result,/Plan \| Limit\nPro \| 10/);assert.match(result,/    if \(x\) \{/);assert.equal(result.split('Repeated useful paragraph.').length,2);assert.equal(result.split('Child').length,2);for(const item of ['Subscribe','Sidebar','Buy now','secret()','Contact us'])assert.equal(result.includes(item),false);
});
test('plain text is read directly and existing context limits remain bounded',()=>{
 assert.equal(websiteText('abc\r\ndef',{plainText:true}),'abc\ndef');assert.equal(websiteText('abcdefgh',{plainText:true,limit:4}),'abcd');
});
