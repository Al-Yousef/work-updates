'use strict';
// Show original reference and native captures without modifying their pixels.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const native = path.resolve(root, 'native/windows/build/candidate/artifacts');
const uri = file => 'data:image/png;base64,' + fs.readFileSync(file).toString('base64');
const apple = uri(path.join(root, 'artifacts/design-references/apple-messages-wide.png'));
const hyphen = uri(path.join(native, 'messages-reference-queue.png'));
const details = uri(path.join(native, 'messages-reference-details.png'));
const images = uri(path.join(native, 'messages-reference-chat-draft.png'));
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hyphen · Messages reference review</title>
<style>body{margin:0;background:#ececf0;color:#222;font:15px Arial,sans-serif}main{max-width:1800px;margin:auto;padding:32px}h1{font-size:25px;margin:0 0 10px}p{line-height:1.5;max-width:1000px}a{color:#006fe8}.pair{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:28px}figure{margin:0}figcaption{margin-bottom:12px;font-weight:bold}img{display:block;width:100%;height:auto;border-radius:16px}ul{padding-left:20px;line-height:1.7}small{font-weight:normal;color:#555}@media(max-width:1000px){.pair{grid-template-columns:1fr}}</style>
<main><h1>Hyphen 0.6.5 · actual reference and native render</h1><p>The left image is Apple's original macOS Tahoe Messages screenshot. The right image is the actual native Windows candidate with synthetic chats. Images retain their original aspect ratios.</p>
<div class="pair"><figure><figcaption><a href="https://support.apple.com/guide/messages/welcome/14.0/mac/26">Apple Messages · macOS Tahoe</a></figcaption><img src="${apple}" alt="Official Apple Messages screenshot"></figure><figure><figcaption>Hyphen · native queue conversation</figcaption><img src="${hyphen}" alt="Actual native Hyphen conversation with blue and gray messages"></figure></div>
<ul><li>Inset rounded sidebar, Search, pinned circular entry and compact conversation rows.</li><li>Centered avatar and contact-name pill. The name opens real task details and actions.</li><li>Compact blue/gray balloons and small Add/composer/Send arrangement.</li><li>Hyphen's device/status labels and Queue behavior remain explicit. Fonts and opaque surfaces are Windows adaptations.</li></ul>
<div class="pair"><figure><figcaption>Contact menu · current task and actions</figcaption><img src="${details}" alt="Native task details popover"></figure><figure><figcaption>Images · draft preview and separate conversation</figcaption><img src="${images}" alt="Native image draft and assistant conversation"></figure></div>
<p><small>This is a comparison to the shown Mac screenshot. A current iPhone landscape screenshot and Apple Liquid Glass material have not been reproduced. Native messaging tests use a synthetic backend and simulated window input.</small></p></main></html>`;
const output = path.join(root, 'artifacts/design-references/messages-reference-review.html');
fs.writeFileSync(output, html);
console.log('Saved reference comparison using unchanged Apple and native capture images.');
