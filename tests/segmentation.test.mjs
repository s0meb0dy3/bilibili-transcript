import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { segmentCues, sentenceRanges, SEGMENTATION_VERSION } from '../extension/segmentation.js';

function cue(id, text, startMs = 0, endMs = startMs + 1000) {
  return { id, startMs, endMs, text };
}

// Verify exact coverage, order and offsets, not only concatenated paragraph text.
function assertLossless(cues, paragraphs) {
  assert.equal(paragraphs.map((paragraph) => paragraph.text).join(''),
    cues.map((entry) => entry.text).join(''));
  const byId = new Map(cues.map((entry) => [entry.id, entry]));
  const consumed = new Map(cues.map((entry) => [entry.id, 0]));
  const sourceOrder = [];
  for (const paragraph of paragraphs) {
    assert.deepEqual(paragraph.cueIds, paragraph.sourceRanges.map((range) => range.cueId));
    assert.equal(paragraph.text, paragraph.sourceRanges.map(({ cueId, start, end }) => {
      const source = byId.get(cueId);
      assert.equal(start, consumed.get(cueId));
      assert.ok(end > start && end <= source.text.length);
      consumed.set(cueId, end);
      sourceOrder.push(cueId);
      return source.text.slice(start, end);
    }).join(''));
    const referenced = paragraph.cueIds.map((id) => byId.get(id));
    assert.equal(paragraph.startMs, referenced[0].startMs);
    assert.equal(paragraph.endMs, Math.max(...referenced.map((entry) => entry.endMs)));
  }
  assert.deepEqual(sourceOrder.filter((id, index) => index === 0 || id !== sourceOrder[index - 1]),
    cues.filter((entry) => entry.text.length > 0).map((entry) => entry.id));
  for (const entry of cues) assert.equal(consumed.get(entry.id), entry.text.length);
}

test('empty input and empty cues produce no phantom paragraphs', () => {
  assert.deepEqual(segmentCues([]), []);
  assert.deepEqual(segmentCues([cue('empty', '')]), []);
  assert.equal(typeof SEGMENTATION_VERSION, 'string');
});

test('a sentence crosses cues and only punctuation supplies a boundary', () => {
  const cues = [cue('a', '这是跨', 100, 200), cue('b', '字幕的完整句子。下一', 200, 400),
    cue('c', '句。', 400, 700)];
  const result = segmentCues(cues, { targetChars: 10 });
  assert.deepEqual(result.map((entry) => entry.text), ['这是跨字幕的完整句子。', '下一句。']);
  assert.deepEqual(result[0].sourceRanges,
    [{ cueId: 'a', start: 0, end: 3 }, { cueId: 'b', start: 0, end: 8 }]);
  assert.deepEqual(result[1].sourceRanges,
    [{ cueId: 'b', start: 8, end: 10 }, { cueId: 'c', start: 0, end: 2 }]);
  assert.equal(result[1].startMs, 200);
  assertLossless(cues, result);
});

test('merge complete sentences at the boundary closest to the target', () => {
  const cues = [cue('a', '甲甲甲。乙乙乙。丙丙丙。丁丁丁。')];
  assert.deepEqual(segmentCues(cues, { targetChars: 7 }).map((entry) => entry.text),
    ['甲甲甲。乙乙乙。', '丙丙丙。丁丁丁。']);
  assert.deepEqual(segmentCues(cues, { targetChars: 5 }).map((entry) => entry.text),
    ['甲甲甲。', '乙乙乙。', '丙丙丙。', '丁丁丁。']);
  assertLossless(cues, segmentCues(cues, { targetChars: 7 }));
});

test('the default target is 200 characters, allowing a closer boundary beyond it', () => {
  const sentence = `${'字'.repeat(69)}。`;
  const cues = [cue('a', sentence.repeat(6))];
  assert.deepEqual(segmentCues(cues).map((entry) => entry.text.length), [210, 210]);
});

test('a single sentence beyond the target is never cut', () => {
  const long = `${'长'.repeat(700)}。`;
  const cues = [cue('a', `短句。${long}末句。`)];
  const result = segmentCues(cues);
  assert.deepEqual(result.map((entry) => entry.text), ['短句。', long, '末句。']);
  assertLossless(cues, result);
});

test('unpunctuated speech stays whole despite cue boundaries and very long pauses', () => {
  const cues = [cue('a', '没有标点'.repeat(100), 0, 1000),
    cue('b', '仍是同一片段'.repeat(100), 5000, 6000),
    cue('c', '尚未结束', 60000, 61000)];
  const result = segmentCues(cues, { targetChars: 5 });
  assert.equal(result.length, 1);
  assert.ok(result[0].text.length > 200);
  assertLossless(cues, result);
});

test('a long unfinished tail is indivisible', () => {
  const tail = '未完'.repeat(300);
  const cues = [cue('a', `已完。${tail}`)];
  assert.deepEqual(segmentCues(cues).map((entry) => entry.text), ['已完。', tail]);
});

test('closing quotes and consecutive sentence marks stay with their sentence across cues', () => {
  const cues = [cue('a', '他说：“真的？！'), cue('b', '”\n下一句！')];
  const result = segmentCues(cues, { targetChars: 1 });
  assert.deepEqual(result.map((entry) => entry.text), ['他说：“真的？！”\n', '下一句！']);
  assertLossless(cues, result);
});

test('commas, colons, semicolons and ellipses alone do not prove sentence ends', () => {
  const text = '甲，乙,丙；丁;戊：己:庚……辛';
  assert.deepEqual(sentenceRanges(text), [{ start: 0, end: text.length }]);
});

test('decimal numbers and URL dots do not split sentences', () => {
  const cues = [cue('a', '值3.14，网址https://example.com/path。Done. Next!')];
  const result = segmentCues(cues, { targetChars: 1 });
  assert.deepEqual(result.map((entry) => entry.text),
    ['值3.14，网址https://example.com/path。', 'Done. ', 'Next!']);
  assertLossless(cues, result);
});

test('Unicode targets count code points; source offsets remain exact UTF-16 slices', () => {
  const cues = [cue(1, '😀。😃。😄。')];
  const result = segmentCues(cues, { targetChars: 4 });
  assert.deepEqual(result.map((entry) => entry.text), ['😀。😃。', '😄。']);
  assert.deepEqual(result[0].sourceRanges, [{ cueId: 1, start: 0, end: 6 }]);
  assertLossless(cues, result);
});

test('whitespace, empty intervening cues, input objects and deterministic ids are preserved', () => {
  const cues = [cue('a', '  首句。\n', 0, 2000), cue('empty', '', 2000, 3000),
    cue('b', '\t尾句！  ', 3000, 4000)];
  const before = structuredClone(cues);
  cues.forEach(Object.freeze);
  Object.freeze(cues);
  const result = segmentCues(cues, { targetChars: 1 });
  assertLossless(cues, result);
  assert.deepEqual(cues, before);
  assert.deepEqual(result, segmentCues(cues, { targetChars: 1 }));
  assert.equal(new Set(result.map((entry) => entry.id)).size, result.length);
});

test('invalid character targets fail explicitly', () => {
  for (const targetChars of [0, -1, NaN, Infinity, '200']) {
    assert.throws(() => segmentCues([], { targetChars }), RangeError);
  }
});

test('all existing subtitle JSON samples retain exact source coverage and original timestamps', async (t) => {
  const directory = new URL('../fixtures/subtitles/', import.meta.url);
  const filenames = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
  assert.ok(filenames.length > 0);
  for (const filename of filenames) {
    await t.test(filename, async () => {
      const raw = JSON.parse(await readFile(new URL(filename, directory), 'utf8'));
      const cues = raw.body.map((entry, index) => cue(entry.sid ?? index + 1, entry.content,
        Math.round(entry.from * 1000), Math.round(entry.to * 1000)));
      const before = structuredClone(cues);
      const result = segmentCues(cues);
      assertLossless(cues, result);
      assert.deepEqual(cues, before);
      const original = cues.map((entry) => entry.text).join('');
      if (!/[。！？!?.]/.test(original)) assert.equal(result.length, 1);
      t.diagnostic(`${filename}: ${cues.length} cues, ${Array.from(original).length} characters, ` +
        `${result.length} paragraphs, longest ${Math.max(...result.map((entry) => Array.from(entry.text).length))}`);
    });
  }
});
