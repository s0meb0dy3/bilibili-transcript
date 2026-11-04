import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSubtitles, cacheKey } from '../extension/subtitles.js';
import { activeCueAt, formatTime, toMarkdown, buildSentenceRuns } from '../extension/panel.js';
import { segmentCues } from '../extension/segmentation.js';

const raw = { body: [
  { sid: 1, from: .72, to: 4.14, content: '第一句话。' },
  { sid: 2, from: 5, to: 10.54, content: '第二句话。' }
] };

test('normalization preserves source text and converts seconds to milliseconds', () => {
  const cues = normalizeSubtitles(raw);
  assert.deepEqual(cues[0], { id: '1', text: '第一句话。', startMs: 720, endMs: 4140 });
});

test('invalid subtitle format is a parsing error rather than no subtitles', () => {
  assert.throws(() => normalizeSubtitles({}), /解析/);
  assert.throws(() => normalizeSubtitles({ body: [{ content: 'x', from: 2, to: 1 }] }), /解析/);
});

test('playback lookup handles boundaries, silence and reverse seeking', () => {
  const cues = normalizeSubtitles(raw);
  for (const [time, expected] of [[0, null], [720, '1'], [4139, '1'], [4140, null], [5000, '2'], [10540, null], [800, '1']]) {
    assert.equal(activeCueAt(cues, time), expected, `time=${time}`);
  }
  assert.equal(activeCueAt([], 0), null);
});

test('cache identity isolates parts and language tracks', () => {
  assert.notEqual(cacheKey({ key: 'BVtest:1' }, 'zh'), cacheKey({ key: 'BVtest:2' }, 'zh'));
  assert.notEqual(cacheKey({ key: 'BVtest:1' }, 'zh'), cacheKey({ key: 'BVtest:1' }, 'ai-zh'));
});

test('timestamp formatting supports hours without rolling over', () => {
  assert.equal(formatTime(720), '00:00');
  assert.equal(formatTime(2676540), '44:36');
  assert.equal(formatTime(3600000), '01:00:00');
});

test('Markdown exports original words and links to the correct part', () => {
  const cues = normalizeSubtitles(raw);
  const paragraphs = segmentCues(cues);
  const md = toMarkdown({
    context: { title: '演讲', part: 2, partTitle: '下半段', bvid: 'BVtest' },
    track: { automatic: true, language: 'ai-zh' }, paragraphs
  });
  assert.ok(md.includes('第一句话。第二句话。'));
  assert.ok(md.includes('BVtest/?p=2&t=0'));
  assert.ok(md.includes('未标注'));
  assert.ok(md.includes('自动中文字幕'));
});

test('click targets join a sentence across cues and seek to its first cue', () => {
  const cues = [
    { id: '1', startMs: 1000 }, { id: '2', startMs: 2000 }, { id: '3', startMs: 3000 }
  ];
  const fragments = [{ cueId: '1', text: '你好，' }, { cueId: '2', text: '世界。再' }, { cueId: '3', text: '见。' }];
  const runs = buildSentenceRuns(fragments, cues);
  assert.deepEqual(runs.map(run => [run.text, run.startMs]), [['你好，世界。', 1000], ['再见。', 2000]]);
  assert.equal(runs.flatMap(run => run.fragments).map(part => part.text).join(''), '你好，世界。再见。');
  assert.deepEqual(runs[0].fragments.map(part => part.cueId), ['1', '2']);
});

test('without sentence boundaries, click targets keep subtitle timing granularity', () => {
  const runs = buildSentenceRuns([{ cueId: '1', text: '这一句没有标点' }, { cueId: '2', text: '还有下一条字幕' }], [
    { id: '1', startMs: 100 }, { id: '2', startMs: 2500 }
  ]);
  assert.deepEqual(runs.map(run => run.startMs), [100, 2500]);
});

test('sentences within one subtitle share its real start rather than fabricated word timing', () => {
  const runs = buildSentenceRuns([{ cueId: '1', text: '第一句。第二句。' }], [{ id: '1', startMs: 1200 }]);
  assert.deepEqual(runs.map(run => run.startMs), [1200, 1200]);
});
