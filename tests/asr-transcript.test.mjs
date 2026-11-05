import test from 'node:test';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { normalizeTranscript, paragraphize } from '../extension/transcript.js';

test('real original M4A fixture preserves five speakers, all text and timestamps', async () => {
  const raw = JSON.parse(await readFile(new URL('../fixtures/asr/BV1Gg411D7i7.json', import.meta.url), 'utf8'));
  assert.equal(raw.file_url, undefined);
  const cues = normalizeTranscript(raw);
  const paragraphs = paragraphize(cues);
  assert.equal(cues.length, 168);
  assert.equal(new Set(cues.map(cue => cue.speakerId)).size, 5);
  assert.equal(paragraphs.length, 50);
  assertCoverage(cues, paragraphs);
});

const sentence = (index, speaker = 0, text = `第${index}句。`) => ({
  begin_time: index * 1000, end_time: index * 1000 + 900,
  sentence_id: 99, speaker_id: speaker, text,
  words: [{ begin_time: index * 1000, end_time: index * 1000 + 900, text, punctuation: '。', confidence: 0.9 }]
});
const normalize = sentences => normalizeTranscript({ transcripts: [{ sentences }] });

function assertCoverage(cues, paragraphs) {
  assert.equal(paragraphs.map(p => p.text).join(''), cues.map(cue => cue.text).join(''));
  assert.deepEqual(paragraphs.flatMap(p => p.cueIds), cues.map(cue => cue.id));
  const byId = new Map(cues.map(cue => [cue.id, cue]));
  for (const paragraph of paragraphs) {
    assert.equal(paragraph.text, paragraph.sourceRanges.map(range => byId.get(range.cueId).text.slice(range.start, range.end)).join(''));
    assert.ok(paragraph.cueIds.every(id => byId.get(id).speakerId === paragraph.speakerId));
    assert.equal(paragraph.startMs, byId.get(paragraph.cueIds[0]).startMs);
    assert.equal(paragraph.endMs, Math.max(...paragraph.cueIds.map(id => byId.get(id).endMs)));
  }
}

test('normalization sorts timestamps across channels and preserves words verbatim', () => {
  const first = sentence(0, 0, '空 格 😀。');
  const second = sentence(1, null);
  const third = sentence(2, 4);
  const raw = { transcripts: [{ sentences: [third, first] }, { sentences: [second] }] };
  const snapshot = structuredClone(raw);
  const cues = normalizeTranscript(raw);
  assert.deepEqual(cues.map(c => c.id), ['1', '2', '3']);
  assert.deepEqual(cues.map(c => c.speakerId), ['0', 'unknown', '4']);
  assert.equal(cues[0].words, first.words);
  assert.equal(cues[0].text, first.text);
  assert.equal(cues[2].startMs, 2000);
  assert.deepEqual(raw, snapshot);
  assert.deepEqual(normalizeTranscript({ transcripts: [] }), []);
});

test('invalid timestamps and malformed input fail instead of inventing times', () => {
  for (const [begin_time, end_time] of [[-1, 100], [10, 9], [NaN, 100], [0, Infinity], ['0', 1]]) {
    assert.throws(() => normalize([{ ...sentence(0), begin_time, end_time }]), /time range/);
  }
  assert.throws(() => normalizeTranscript({}), /transcripts/);
  assert.throws(() => normalizeTranscript({ transcripts: [{}] }), /sentences/);
  assert.throws(() => normalize([{ ...sentence(0), text: undefined }]), /text/);
});

test('five-speaker fixture keeps every turn separate, including a returning speaker', () => {
  const cues = normalize([0, 1, 2, 3, 4, 0].flatMap((speaker, turn) => [
    sentence(turn * 2, speaker), sentence(turn * 2 + 1, speaker)
  ]));
  const paragraphs = paragraphize(cues);
  assert.deepEqual(paragraphs.map(p => p.speakerId), ['0', '1', '2', '3', '4', '0']);
  assertCoverage(cues, paragraphs);
});

test('rule grouping supports many paragraphs in one turn without splitting a huge ASR sentence', () => {
  const cues = normalize([
    sentence(0, 0, '甲'.repeat(124) + '。'), sentence(1, 0, '乙'.repeat(124) + '。'),
    sentence(2, 0, '丙'.repeat(800) + '。里面还有句号。'), sentence(3, 0, '末句😀。')
  ]);
  const snapshot = structuredClone(cues);
  const paragraphs = paragraphize(cues);
  assert.deepEqual(paragraphs.map(p => p.cueIds), [['1', '2'], ['3'], ['4']]);
  assert.equal(paragraphs[0].text.length, 250);
  assert.equal(paragraphs[1].text, cues[2].text);
  assertCoverage(cues, paragraphs);
  assert.deepEqual(cues, snapshot);
  assert.throws(() => paragraphize(cues, { targetChars: 0 }), /targetChars/);
});
