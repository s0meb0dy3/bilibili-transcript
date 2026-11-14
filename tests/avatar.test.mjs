import test from 'node:test';
import assert from 'node:assert/strict';
import { candidateTimes, chooseAvatars, concreteName, initialAvatar, parseBox, parsePeople, visionPrompt } from '../extension/avatar.js';

const box = (x1, y1, x2, y2) => ({ x1, y1, x2, y2 });
const person = (name, b) => ({ name, box: b });

test('samples frames from the longest turns of every speaker', () => {
  const cues = [
    { speakerId: '0', startMs: 0, endMs: 1000 }, { speakerId: '0', startMs: 1000, endMs: 2000 },
    { speakerId: '1', startMs: 2000, endMs: 12000 },
    { speakerId: '0', startMs: 12000, endMs: 30000 }
  ];
  const times = candidateTimes(cues, { maxTurns: 2, perTurn: 2 });
  assert.ok(times.some(item => item.speakerId === '0' && item.timeMs === 18000));
  assert.ok(times.some(item => item.speakerId === '1' && item.timeMs === 5333));
  assert.equal(times.length, 6);
  assert.deepEqual([...times].sort((a, b) => a.timeMs - b.timeMs), times);
});

test('parses every box shape the vision model returns', () => {
  assert.deepEqual(parseBox('<box>(100,200),(300,400)</box>'), box(100, 200, 300, 400));
  assert.deepEqual(parseBox('(148, 238), (447, 999)'), box(148, 238, 447, 999));
  assert.deepEqual(parseBox([10, 20, 30, 40]), box(10, 20, 30, 40));
  assert.deepEqual(parseBox({ bbox_2d: [556, 228, 870, 997] }), box(556, 228, 870, 997));
  assert.deepEqual(parseBox({ box_2d: [51, 198, 158, 381] }), box(198, 51, 381, 158));
  assert.equal(parseBox('nothing'), null);
});

test('parses people from fenced or plain JSON', () => {
  const text = '```json\n[{"box":"<box>(1,2,3,4)</box>","name":"雷军","position":"右"}]\n```';
  assert.deepEqual(parsePeople(text), [{ box: box(1, 2, 3, 4), name: '雷军', position: '右' }]);
  assert.deepEqual(parsePeople('{"people":[]}'), []);
});

test('builds a strict prompt that forbids guessing', () => {
  const prompt = visionPrompt({ title: '访谈', description: '雷军接受采访', uploader: '频道', nearbyText: '雷总，您好', candidates: ['雷军', '许知远'] });
  assert.match(prompt, /看不清或无法确认必须填“不确定”/);
  assert.match(prompt, /禁止猜测/);
  assert.match(prompt, /雷军、许知远/);
  assert.match(prompt, /雷总，您好/);
});

test('name match works across frames, including other speakers’ turns', () => {
  const frames = [
    { speakerId: '0', timeMs: 1000, people: [person('方三文', box(100, 100, 400, 500))] },
    { speakerId: '1', timeMs: 2000, people: [person('段永平', box(500, 100, 900, 500))] }
  ];
  const picks = chooseAvatars(frames, { 0: { name: '方三文' }, 1: { name: '段永平' } });
  assert.equal(picks['0'].timeMs, 1000);
  assert.equal(picks['1'].timeMs, 2000);
  assert.equal(picks['0'].mode, 'name');
});

test('falls back to a single-person shot from the speaker’s own turn', () => {
  const frames = [{ speakerId: '0', timeMs: 1000, people: [person('', box(300, 200, 700, 800))] }];
  const picks = chooseAvatars(frames, { 0: { name: null } });
  assert.equal(picks['0'].mode, 'solo');
});

test('ignores roles for name matching and returns null when nothing qualifies', () => {
  assert.equal(concreteName('主持人'), '');
  assert.equal(concreteName('耿海榕（董事长）'), '耿海榕');
  const frames = [{ speakerId: '0', timeMs: 1000, people: [person('', box(0, 0, 100, 100))] }];
  assert.equal(chooseAvatars(frames, { 0: { name: '主持人' } })['0'], null);
});

test('rejects a lone reaction shot that shows another known speaker', () => {
  const frames = [{ speakerId: '0', timeMs: 1000, people: [person('姚洋', box(300, 200, 700, 800))] }];
  const picks = chooseAvatars(frames, { 0: { name: '主持人' }, 1: { name: '姚洋' } });
  assert.equal(picks['0'], null);
});

test('does not reuse the same face for two speakers', () => {
  const shared = person('雷军', box(500, 100, 900, 500));
  const frames = [{ speakerId: '0', timeMs: 1000, people: [shared] }, { speakerId: '1', timeMs: 1000, people: [shared] }];
  const picks = chooseAvatars(frames, { 0: { name: '雷军' }, 1: { name: '雷军' } });
  assert.ok(picks['0'] || picks['1']);
  assert.ok(!(picks['0'] && picks['1']));
});

test('creates a circular initial avatar as an inline SVG', () => {
  const url = initialAvatar('魏晞', '0');
  assert.match(url, /^data:image\/svg\+xml/);
  assert.match(decodeURIComponent(url), /魏/);
  assert.match(decodeURIComponent(url), /<circle/);
});
