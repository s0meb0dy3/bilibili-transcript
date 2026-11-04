import test from 'node:test';
import assert from 'node:assert/strict';
import { runSemanticSegmentation, semanticToDisplay, takeWindow } from '../extension/semantic.js';

const raw = count => ({ body: Array.from({ length: count }, (_, i) => ({ sid: 99, content: String.fromCodePoint(0x4e00 + i).repeat(19) + '。', from: i * 2, to: i * 2 + 1 })) });
const memory = () => {
  const entries = new Map();
  return { entries, get: async key => entries.get(key), set: async (key, value) => entries.set(key, structuredClone(value)) };
};
const parse = request => JSON.parse(request.messages[1].content);
const answer = (items, group = 2) => ({ response: { paragraphs: Array.from({ length: Math.ceil(items.length / group) }, (_, i) => {
  const part = items.slice(i * group, (i + 1) * group);
  return { start_item: part[0].id, text: part.map(item => item.text).join('') };
}) }, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
const parameters = { windowChars: 80, targetChars: 40, contextChars: 30, maxRetries: 0 };

function runner(overrides = {}) {
  const requests = [];
  const store = memory();
  return {
    requests, store,
    options: {
      raw: raw(10), parameters, store,
      callModel: async request => { requests.push(parse(request)); return answer(parse(request).items); },
      ...overrides
    }
  };
}

test('windows use whole items, keep the last paragraph, and never repeat committed text', async () => {
  const run = runner();
  const result = await runSemanticSegmentation(run.options);
  assert.deepEqual(run.requests.map(request => request.items[0].id), [1, 3, 5, 7]);
  assert.equal(run.requests[0].before, '');
  assert.ok(run.requests[1].before.length > 0);
  assert.ok(run.requests[0].after.length <= 30);
  assert.equal(result.paragraphs.map(p => p.raw_text).join(''), raw(10).body.map(i => i.content).join(''));
  assert.equal(result.paragraphs.at(-1).end_item, 10);
  assert.ok(result.paragraphs.every(p => p.text.length <= 350));
  assert.equal(result.stats.totalTokens, 60);
});

test('completed checkpoint avoids duplicate calls and validates the source again', async () => {
  const run = runner();
  await runSemanticSegmentation(run.options);
  const count = run.requests.length;
  const result = await runSemanticSegmentation(run.options);
  assert.equal(run.requests.length, count);
  assert.equal(result.paragraphs.length, 5);
});

test('changed model creates a different checkpoint and request cache identity', async () => {
  const run = runner({ raw: raw(4) });
  await runSemanticSegmentation(run.options);
  await runSemanticSegmentation({ ...run.options, model: 'other-model' });
  assert.equal(run.requests.length, 2);
});

test('only a paragraph with changed words is retried, with exact mismatch feedback', async () => {
  const requests = [];
  const result = await runSemanticSegmentation({
    raw: raw(4), store: memory(), parameters: { ...parameters, windowChars: 100, maxRetries: 2 },
    callModel: async request => {
      const data = parse(request); requests.push(data);
      const result = answer(data.items);
      if (requests.length === 1) result.response.paragraphs[1].text = '被改写了。';
      return result;
    }
  });
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].items.map(i => i.id), [3, 4]);
  assert.match(requests[1].correction, /上次错误输出/);
  assert.equal(result.paragraphs[0].start_item, 1);
  assert.equal(result.stats.retries, 1);
});

test('length violation is repaired only inside that paragraph', async () => {
  let calls = 0;
  const result = await runSemanticSegmentation({
    raw: raw(4), store: memory(), parameters: { ...parameters, windowChars: 100, maxChars: 45, maxRetries: 2 },
    callModel: async request => { calls++; return answer(parse(request).items, calls === 1 ? 4 : 2); }
  });
  assert.equal(calls, 2);
  assert.equal(result.paragraphs.length, 2);
  assert.ok(result.paragraphs.every(p => p.text.length <= 45));
});

test('no-progress result fails with a checkpoint instead of looping', async () => {
  const run = runner({ callModel: async request => answer(parse(request).items, 100) });
  await assert.rejects(runSemanticSegmentation(run.options), /至少需要两段/);
  const checkpoint = [...run.store.entries.values()].find(value => value.status === 'failed');
  assert.equal(checkpoint.cursor, 0);
  assert.deepEqual(checkpoint.raw, run.options.raw);
});

test('failed task retries at most twice and retains untouched source', async () => {
  let calls = 0;
  const store = memory();
  await assert.rejects(runSemanticSegmentation({
    raw: raw(2), store, parameters: { ...parameters, maxRetries: 2 },
    callModel: async request => {
      calls++;
      const result = answer(parse(request).items);
      result.response.paragraphs[0].text = '被改了。';
      return result;
    }
  }), /正文/);
  assert.equal(calls, 3);
  assert.equal([...store.entries.values()].find(v => v.status === 'failed').raw.body.length, 2);
});

test('cancelled task resumes at the first uncommitted item', async () => {
  const run = runner();
  const controller = new AbortController();
  await assert.rejects(runSemanticSegmentation({ ...run.options, signal: controller.signal,
    onProgress: ({ completed }) => { if (completed > 0) controller.abort(); }
  }), /取消/);
  assert.equal(run.requests.length, 1);
  const result = await runSemanticSegmentation(run.options);
  assert.equal(run.requests[1].items[0].id, 3);
  assert.equal(result.paragraphs.at(-1).end_item, 10);
});

test('display maps inserted punctuation to source cue IDs and exact original times', async () => {
  const result = await runSemanticSegmentation({
    raw: { body: [{ content: '你好', from: .1, to: 1 }, { content: '世界', from: 1, to: 2 }] },
    store: memory(), parameters,
    callModel: async () => ({ response: { paragraphs: [{ start_item: 1, text: '你好，世界。' }] } })
  });
  const display = semanticToDisplay(result);
  assert.equal(display[0].displayFragments.map(f => f.text).join(''), '你好，世界。');
  assert.deepEqual(display[0].cueIds, ['1', '2']);
  assert.equal(display[0].startMs, 100);
  assert.equal(display[0].endMs, 2000);
});

test('empty input and whole-item window selection do not call the model', async () => {
  let calls = 0;
  const result = await runSemanticSegmentation({ raw: { body: [] }, store: memory(), callModel: async () => { calls++; } });
  assert.equal(calls, 0);
  assert.deepEqual(result.paragraphs, []);
  assert.equal(takeWindow([{ text: '甲'.repeat(100) }, { text: '乙' }], 0, 20).end, 1);
});
