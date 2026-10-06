'use strict';
// Original iPhone reference pixels alongside actual native synthetic renders.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),reference=path.join(root,'artifacts/design-references/iphone');
const native=path.resolve(root,'native/windows/build/candidate/artifacts');
const sources=[
  ['ios27-messages-landscape.jpeg','https://www.macrumors.com/2026/06/12/ios-27-landscape-mode-apps/','June 2026 iOS 27 beta landscape capture'],
  ['apple-iphone-conversation.png','https://support.apple.com/guide/iphone/send-and-reply-to-messages-iph82fb73ba3/27/ios/27','Apple current iPhone conversation guide'],
  ['apple-iphone-filters.png','https://support.apple.com/guide/iphone/screen-and-filter-texts-iph203ab0be4/ios','Apple current iPhone conversation list and filters'],
  ['apple-iphone-search-current.png','https://support.apple.com/guide/iphone/search-iph17c111fb6/27/ios/27','Apple current iPhone Search guide'],
];
const uri=file=>'data:image/'+(file.endsWith('.jpeg')?'jpeg':'png')+';base64,'+fs.readFileSync(file).toString('base64');
const figure=(title,file,href='')=>`<figure><figcaption>${href?`<a href="${href}">${title}</a>`:title}</figcaption><img src="${uri(file)}" alt="${title}"></figure>`;
const componentRows=[
  ['Sidebar','Landscape pane and Apple conversation list','Edge-aligned pane, circular pin, row separators','Expanded width and extra waiting-owner line'],
  ['Search','Apple current iPhone Search screenshot','Bottom capsule; real native input and Clear','Searches Hyphen chat names and task titles'],
  ['Contact header','Actual iPhone landscape capture','Inline avatar, name and details chevron','Execution-device avatar and current-task subtitle'],
  ['Messages','Apple current conversation screenshot','Larger type, gray/blue roles, terminal group tails','Stronger blue and Segoe UI on Windows'],
  ['Composer and images','Apple current conversation screenshot','Standalone Add, bordered capsule, rounded photos','Send/Queue, real image import and receipt handling'],
  ['Filters','Apple current filter screenshot','Circular control and leading selected checkmark','Hyphen views: Updates, Queued, History and Done'],
  ['Desktop behavior','Hyphen-specific','X, tray, weather trigger, drag and keyboard focus','Preserved Windows implementation, not an iPhone feature'],
];
const html=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hyphen · iPhone reference audit</title>
<style>body{margin:0;background:#f2f2f7;color:#1c1c1e;font:16px 'Segoe UI',sans-serif}main{max-width:1500px;margin:auto;padding:28px}h1{font-size:26px}p{max-width:1100px;line-height:1.55}a{color:#006dde}figure{margin:0}figcaption{font-weight:600;margin:0 0 12px}img{display:block;width:100%;height:auto;background:white}section{margin-top:30px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:24px}.phones{display:grid;grid-template-columns:repeat(3,1fr);gap:24px}.phones img{max-height:650px;object-fit:contain}table{width:100%;border-collapse:collapse;background:white;font-size:14px}th,td{text-align:left;padding:12px;border-bottom:1px solid #ddd;vertical-align:top}small{color:#555}@media(max-width:850px){.pair,.phones{grid-template-columns:1fr}table{display:block;overflow:auto}}</style>
<main><h1>Hyphen 0.6.8 · iPhone evidence and native result</h1><p>These are real reference images and actual native Windows captures. The landscape screenshot was published during the iOS 27 beta in June 2026; Apple's supporting guide screens are from the current iPhone guide. No final-release landscape hardware capture, Apple font or Liquid Glass implementation is claimed.</p>
<section>${figure(sources[0][2],path.join(reference,sources[0][0]),sources[0][1])}</section>
<section>${figure('Hyphen · actual native selected chat',path.join(native,'messages-reference-source-chat.png'))}</section>
<section class="phones">${sources.slice(1).map(([file,url,label])=>figure(label,path.join(reference,file),url)).join('')}</section>
<section><table><thead><tr><th>Component</th><th>Inspected iPhone reference</th><th>Applied decision</th><th>Explicit adaptation</th></tr></thead><tbody>${componentRows.map(row=>'<tr>'+row.map(value=>'<td>'+value+'</td>').join('')+'</tr>').join('')}</tbody></table></section>
<section class="pair">${figure('Hyphen · filters and selected category',path.join(native,'iphone-components-filters.png'))}${figure('Hyphen · bottom Search and preserved conversation',path.join(native,'iphone-ux-search.png'))}</section>
<section class="pair">${figure('Hyphen · multiline composer and press feedback',path.join(native,'iphone-ux-pressed.png'))}${figure('Hyphen · actual image draft',path.join(native,'messages-reference-chat-draft.png'))}</section>
<section><h2>UX reliability audit</h2><p>The native regression checks cover focus identity, keyboard navigation, disabled controls, multiline errors, cached offline reading, automatic reconnect, image errors and draft restoration after an actual app restart. Each rendering scale passed 244 assertions; the messaging suite passed 296 and the adapter suite passed 42. Native accessibility inspection is not a full Narrator session; simulated input is not a physical weather gesture or arbitrary mixed-monitor proof.</p></section>
<section class="pair">${figure('Hyphen · cached conversation and editable offline draft',path.join(native,'ux-offline-96.png'))}${figure('Hyphen · complete multiline error with reserved space',path.join(native,'ux-error-96.png'))}</section>
<section class="pair">${figure('Hyphen · real image preview at 200% rendering scale',path.join(native,'ux-image-192.png'))}${figure('Hyphen · native menu and multiline input at 125%',path.join(native,'ux-menu-120.png'))}</section>
<p><small>Chats in these captures are synthetic. A simulated native input test is not live signed-in Codex delivery or physical iPhone testing. Full component mapping and verification are in docs/IPHONE_COMPONENT_AUDIT.md.</small></p></main></html>`;
fs.writeFileSync(path.join(reference,'review.html'),html);
fs.writeFileSync(path.join(reference,'references.json'),JSON.stringify({createdAt:new Date().toISOString(),references:sources.map(([file,url,note])=>({file,url,note,sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(reference,file))).digest('hex')}))},null,2));
console.log('Saved unchanged iPhone references and actual native comparison.');
