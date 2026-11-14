import test from 'node:test';
import assert from 'node:assert/strict';
import { activeCueAt, formatTime, toMarkdown, buildSentenceRuns } from '../extension/panel.js';
import { sentenceRanges } from '../extension/text.js';

const cues = [
  { id: '1', text: '第一句话。', startMs: 720, endMs: 4140 },
  { id: '2', text: '第二句话。', startMs: 5000, endMs: 10540 }
];

test('playback lookup handles boundaries, silence and reverse seeking', () => {
  for (const [time, expected] of [[0, null], [720, '1'], [4139, '1'], [4140, null], [5000, '2'], [10540, null], [800, '1']]) {
    assert.equal(activeCueAt(cues, time), expected, `time=${time}`);
  }
  assert.equal(activeCueAt([], 0), null);
});

test('timestamp formatting supports hours without rolling over', () => {
  assert.equal(formatTime(720), '00:00');
  assert.equal(formatTime(2676540), '44:36');
  assert.equal(formatTime(3600000), '01:00:00');
});

test('Markdown exports ASR words, speaker and links to the correct part', () => {
  const md = toMarkdown({
    context: { title: '演讲', part: 2, partTitle: '下半段', bvid: 'BVtest' },
    source: '百炼 ASR',
    paragraphs: [{ id: 'p1', speakerId: '0', startMs: 720, text: cues.map(cue => cue.text).join('') }]
  });
  assert.ok(md.includes('第一句话。第二句话。'));
  assert.ok(md.includes('BVtest/?p=2&t=0'));
  assert.ok(md.includes('未知发言人'));
  assert.ok(md.includes('百炼 ASR'));
});

test('click targets join a sentence across fragments and seek to its first cue', () => {
  const cues = [
    { id: '1', startMs: 1000 }, { id: '2', startMs: 2000 }, { id: '3', startMs: 3000 }
  ];
  const fragments = [{ cueId: '1', text: '你好，' }, { cueId: '2', text: '世界。再' }, { cueId: '3', text: '见。' }];
  const runs = buildSentenceRuns(fragments, cues);
  assert.deepEqual(runs.map(run => [run.text, run.startMs]), [['你好，世界。', 1000], ['再见。', 2000]]);
  assert.equal(runs.flatMap(run => run.fragments).map(part => part.text).join(''), '你好，世界。再见。');
  assert.deepEqual(runs[0].fragments.map(part => part.cueId), ['1', '2']);
});

test('without sentence boundaries, click targets retain available cue timing', () => {
  const runs = buildSentenceRuns([{ cueId: '1', text: '这一句没有标点' }, { cueId: '2', text: '还有下一句' }], [
    { id: '1', startMs: 100 }, { id: '2', startMs: 2500 }
  ]);
  assert.deepEqual(runs.map(run => run.startMs), [100, 2500]);
});

test('sentences within one cue share its real start rather than fabricated word timing', () => {
  const runs = buildSentenceRuns([{ cueId: '1', text: '第一句。第二句。' }], [{ id: '1', startMs: 1200 }]);
  assert.deepEqual(runs.map(run => run.startMs), [1200, 1200]);
});

test('lightweight sentence ranges preserve quotes, whitespace and UTF-16 offsets', () => {
  const text = '😀他说：“真的？！”\n下一句！';
  const ranges = sentenceRanges(text);
  assert.deepEqual(ranges.map(({ start, end }) => text.slice(start, end)), ['😀他说：“真的？！”\n', '下一句！']);
  assert.equal(ranges[0].start, 0);
  assert.equal(ranges.at(-1).end, text.length);
  assert.equal(ranges[0].end, ranges[1].start);
});

test('sentence ranges do not split decimals, URLs or weak punctuation', () => {
  const text = '值3.14，网址https://example.com/path。Done. Next!';
  assert.deepEqual(sentenceRanges(text).map(({ start, end }) => text.slice(start, end)),
    ['值3.14，网址https://example.com/path。', 'Done. ', 'Next!']);
  const unfinished = '甲，乙,丙；丁;戊：己:庚……辛';
  assert.deepEqual(sentenceRanges(unfinished), [{ start: 0, end: unfinished.length }]);
  assert.deepEqual(sentenceRanges(''), []);
});
