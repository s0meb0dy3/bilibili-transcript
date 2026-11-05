import test from 'node:test';
import assert from 'node:assert/strict';
import { getPerson } from '../extension/people.js';
import { toMarkdown } from '../extension/panel.js';
test('names use inferred mapping, retain speaker zero, and unknown speakers stay distinct', () => {
  const people = { '0': { id: '0', name: '魏晞', evidence: ['魏晞主持对话。'], inferred: true } };
  assert.equal(getPerson('0', people).name, '魏晞');
  assert.equal(getPerson('1', people).name, '未知发言人 2');
  assert.equal(getPerson('unknown', people).name, '未知发言人');
  const md = toMarkdown({ context: { title: '圆桌', part: 1, partTitle: '', bvid: 'BVtest' }, track: {}, people, paragraphs: [{ speakerId: '0', startMs: 500, text: '你好。' }] });
  assert.ok(md.includes('魏晞'));
});
