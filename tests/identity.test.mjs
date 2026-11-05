import test from 'node:test';
import assert from 'node:assert/strict';
import { inferPeople } from '../extension/identity.js';

const cues = [
  { speakerId: 0, text: '大家好，我叫张三。' },
  { speakerId: '1', text: '张三你好，我是 Alice Smith。' },
  { speakerId: 'unknown', text: '这句话没有说话人标记。' }
];
const metadata = {
  title: '张三与 Alice 的访谈',
  description: '嘉宾张三和 Alice Smith 聊创业',
  uploader: { name: '某频道', bio: '日常记录', verification: '创作者' }
};
const people = list => ({ response: { people: list } });
const memory = () => {
  const entries = new Map();
  return { entries, get: async key => entries.get(key), set: async (key, value) => entries.set(key, value) };
};

test('sends the full transcript and video metadata in one request', async () => {
  let prompt;
  const result = await inferPeople({
    cues, metadata, callModel: async request => {
      prompt = request.messages[0].content;
      return people([
        { speaker_id: '0', name: '张三' },
        { speaker_id: '1', name: 'Alice Smith' }
      ]);
    }
  });
  for (const cue of cues) assert.ok(prompt.includes(cue.text), cue.text);
  assert.match(prompt, /张三与 Alice 的访谈/);
  assert.match(prompt, /嘉宾张三和 Alice Smith 聊创业/);
  assert.match(prompt, /UP主：某频道/);
  assert.match(prompt, /日常记录/);
  assert.equal(result['0'].name, '张三');
  assert.equal(result['1'].name, 'Alice Smith');
  assert.equal(result.unknown.name, null);
});

test('keeps speaker 0, ignores invented ids, and rejects names absent from every source', async () => {
  const result = await inferPeople({
    cues, metadata, callModel: async () => people([
      { speaker_id: 0, name: '张三' },
      { speaker_id: '1', name: '李四' },
      { speaker_id: 'unknown', name: '张三' },
      { speaker_id: 'invented', name: '张三' }
    ])
  });
  assert.deepEqual(Object.keys(result), ['0', '1', 'unknown']);
  assert.equal(result['0'].name, '张三');
  assert.equal(result['1'].name, null);
  assert.equal(result.unknown.name, null);
});

test('accepts roles and name-with-role labels', async () => {
  const result = await inferPeople({
    cues, metadata, callModel: async () => people([
      { speaker_id: '0', name: '主持人' },
      { speaker_id: '1', name: 'Alice Smith（嘉宾）' }
    ])
  });
  assert.equal(result['0'].name, '主持人');
  assert.equal(result['1'].name, 'Alice Smith（嘉宾）');
});

test('a concrete name is assigned to only one speaker, preferring the one who spoke more', async () => {
  const long = [
    { speakerId: '0', text: '张三' + '说'.repeat(300) },
    { speakerId: '1', text: '张三' }
  ];
  const result = await inferPeople({
    cues: long, metadata: { title: '张三' }, callModel: async () => people([
      { speaker_id: '0', name: '张三' },
      { speaker_id: '1', name: '张三' }
    ])
  });
  assert.equal(result['0'].name, '张三');
  assert.equal(result['1'].name, null);
});

test('splits very long transcripts into chunks and merges the answers', async () => {
  const many = Array.from({ length: 300 }, (_, index) => ({
    speakerId: index % 2 === 0 ? '0' : '1',
    text: (index % 2 === 0 ? '甲' : '乙') + `第${index}句` + '内容'.repeat(220)
  }));
  let calls = 0;
  const result = await inferPeople({
    cues: many, metadata: { title: '长视频' }, callModel: async () => {
      calls++;
      return people([{ speaker_id: '0', name: '甲' }, { speaker_id: '1', name: '乙' }]);
    }
  });
  assert.ok(calls >= 2, `expected multiple chunks, got ${calls}`);
  assert.equal(result['0'].name, '甲');
  assert.equal(result['1'].name, '乙');
});

test('caches validated answers and invalidates on source, metadata and model changes', async () => {
  const store = memory();
  let calls = 0;
  const options = { cues, metadata, store, callModel: async () => { calls++; return people([{ speaker_id: '0', name: '张三' }]); } };
  await inferPeople(options);
  await inferPeople(options);
  assert.equal(calls, 1);
  await inferPeople({ ...options, cues: [...cues, { speakerId: '0', text: '补充' }] });
  await inferPeople({ ...options, metadata: { ...metadata, title: '新标题' } });
  await inferPeople({ ...options, model: 'another-model' });
  assert.equal(calls, 4);
});

test('pre-abort and abort after transport prevent persistence and propagate the signal', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(inferPeople({ cues, signal: controller.signal, callModel: () => assert.fail('should not call') }), { name: 'AbortError' });
  const active = new AbortController();
  const store = memory();
  await assert.rejects(inferPeople({
    cues, store, signal: active.signal,
    callModel: async (_request, { signal }) => {
      assert.equal(signal, active.signal);
      active.abort();
      return people([{ speaker_id: '0', name: '张三' }]);
    }
  }), { name: 'AbortError' });
  assert.equal(store.entries.size, 0);
});
