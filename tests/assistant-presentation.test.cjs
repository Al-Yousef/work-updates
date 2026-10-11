'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {presentAnswer}=require('../src/assistant-presentation.cjs');
const {nativeView}=require('../src/native-view.cjs');

test('assistant formatting retains paragraphs, lists and UTF-16 style ranges',()=>{
  const raw='😀 **Ready**\n\n- Review `main.cpp`\n- Keep your draft\n\n1. Open Hyphen\n2. Ask a question';
  const result=presentAnswer(raw);
  assert.equal(result.text,'😀 Ready\n\n• Review main.cpp\n• Keep your draft\n\n1. Open Hyphen\n2. Ask a question');
  assert.deepEqual(result.spans,[{start:3,length:5,kind:'bold'},{start:19,length:8,kind:'code'}]);
  for(const span of result.spans)assert.ok(result.text.slice(span.start,span.start+span.length).length);
});

test('code blocks preserve literal code while malformed formatting and HTML remain text',()=>{
  assert.deepEqual(presentAnswer('Run this:\n```js\nconst x = "**literal**";\n```\nDone.'),{
    text:'Run this:\nconst x = "**literal**";\nDone.',spans:[{start:10,length:24,kind:'code'}]});
  for(const raw of ['**unfinished','`unfinished','```js\nunfinished','<script>alert(1)</script>','\\\\server\\share'])
    assert.equal(presentAnswer(raw).text,raw);
  assert.equal(presentAnswer('## Next step\r\n\r\nUse **the `Send` button**.').text,'Next step\n\nUse the Send button.');
});

test('native presentation is bounded and never mutates history or destination drafts',()=>{
  const message={id:'reply',answer:'**Ready**',status:'completed',links:[{index:0,chatName:'Launch',draft:'**send this literally**'}]};
  const state={assistant:{messages:[message]}};
  const frame=nativeView(state);
  assert.equal(frame.assistant.messages[0].answer,'Ready');
  assert.equal(frame.assistant.messages[0].links[0].hasDraft,true);
  assert.equal(message.answer,'**Ready**');assert.equal(message.links[0].draft,'**send this literally**');
  const unicode=presentAnswer('x'.repeat(5999)+'😀');assert.equal(unicode.text.length,5999);assert.equal(unicode.text.isWellFormed(),true);
  const repeated=presentAnswer('**a** '.repeat(1000));assert.ok(repeated.spans.length<=128);assert.ok(repeated.text.length<=6000);
});
