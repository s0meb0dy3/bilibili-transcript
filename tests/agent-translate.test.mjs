import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { translationBatches, translateBatches } from '../agent/translate.mjs';
import { createServer } from '../agent/server.mjs';

const choice = (translations, finish_reason = 'stop') => Response.json({
  choices: [{ finish_reason, message: { content: JSON.stringify({ translations }) } }]
});
const cue = { id: 'one', text: 'Private example cue.' };

async function setup(t, opts = {}) {
  const root = await mkdtemp(join(tmpdir(), 'translate-test-'));
  const server = await createServer({ root, port: 0, apiKey: 'translation-test-key', bailianApiKey: '', ...opts });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await rm(root, { recursive: true, force: true });
  });
  const url = `${server.connection.url}/translate`;
  const post = (body, opts = {}) => fetch(url, {
    method: 'POST', body: JSON.stringify(body), signal: opts.signal,
    headers: { Authorization: `Bearer ${server.connection.token}`, 'Content-Type': 'application/json', ...opts.headers }
  });
  return { post, root };
}

test('translation batches retain cue order and limit count and UTF-8 JSON payload size', () => {
  const many = Array.from({ length: 36 }, (_, i) => ({ id: String(i), text: 'example' }));
  assert.deepEqual(translationBatches(many).map(x => x.length), [32, 4]);
  const large = many.slice(0, 3).map(x => ({ ...x, text: '汉'.repeat(2000) }));
  const batches = translationBatches(large);
  assert.deepEqual(batches.flat(), large);
  assert.equal(batches.length, 3);
  assert.ok(batches.every(batch => Buffer.byteLength(JSON.stringify(batch)) <= 12_000));
  assert.throws(() => translationBatches([{ ...cue, text: '汉'.repeat(4000) }]), /过长/);
});

test('authenticated translation pins DeepSeek JSON mode and returns exact IDs without task files', async t => {
  let calls = 0;
  const cues = [cue, { id: '__proto__', text: 'Second cue.' }];
  const app = await setup(t, { tracing: { start: () => assert.fail('translation text should not be traced') }, translationFetch: async (url, req) => {
    calls++;
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.equal(req.headers.Authorization, 'Bearer translation-test-key');
    assert.equal(req.redirect, 'error');
    const prompt = JSON.parse(req.body);
    assert.equal(prompt.model, 'deepseek-flash');
    assert.deepEqual(prompt.thinking, { type: 'disabled' });
    assert.deepEqual(prompt.response_format, { type: 'json_object' });
    assert.match(prompt.messages[0].content, /JSON.*"translations"/);
    assert.deepEqual(JSON.parse(prompt.messages[1].content), cues);
    return choice([{ id: '__proto__', text: '第二句。' }, { id: 'one', text: '第一句。' }]);
  } });
  assert.equal((await app.post({ cues }, { headers: { Authorization: '' } })).status, 401);
  assert.equal((await app.post({ cues }, { headers: { Origin: 'https://example.test' } })).status, 403);
  for (const invalid of [[], [null], [cue, cue], [{ ...cue, text: ' ' }], [{ ...cue, id: 42 }]]) {
    assert.equal((await app.post({ cues: invalid })).status, 400);
  }
  assert.equal((await app.post({ cues: [{ ...cue, text: 'x'.repeat(1024 ** 2) }] })).status, 413);
  assert.equal(calls, 0);
  const response = await app.post({ cues });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { translations: { ['__proto__']: '第二句。', one: '第一句。' } });
  assert.equal(calls, 1);
  assert.deepEqual(await readdir(join(app.root, '.private/agent/tasks')), []);
});

test('merges successive provider batches without losing any cue IDs', async () => {
  const cues = Array.from({ length: 33 }, (_, i) => ({ ...cue, id: String(i + 1) }));
  const received = [];
  const result = await translateBatches(translationBatches(cues), { apiKey: 'k', fetchImpl: async (_, { body }) => {
    const batch = JSON.parse(JSON.parse(body).messages[1].content);
    received.push(batch.length);
    return choice(batch.map(({ id }) => ({ id, text: `译文 ${id}` })).reverse());
  } });
  assert.deepEqual(received, [32, 1]);
  assert.deepEqual(result, { translations: Object.fromEntries(cues.map(({ id }) => [id, `译文 ${id}`])) });
});

test('rejects missing, duplicate, unknown or empty translations and truncated JSON without echoing provider errors', async t => {
  const outputs = [
    () => choice([]), () => choice([{ id: 'one', text: '你好' }, { id: 'one', text: '你好' }]),
    () => choice([{ id: 'one', text: '你好' }, { id: 'invented', text: '你好' }]),
    () => choice([{ id: 'one', text: '你好' }, { id: 'two', text: ' ' }]),
    () => choice([{ id: 'one', text: '你好' }, { id: 'two', text: '再见' }], 'length'),
    () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: '  ' } }] }),
    () => new Response('private upstream error body', { status: 429 })
  ];
  const app = await setup(t, { translationFetch: () => outputs.shift()() });
  while (outputs.length) {
    const response = await app.post({ cues: [cue, { ...cue, id: 'two' }] });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: '翻译失败，请稍后重试' });
  }
});

const waitForAbort = signal => new Promise((_, reject) => {
  signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});

test('upstream batch timeout propagates and no more batches start', async () => {
  const batches = translationBatches(Array.from({ length: 33 }, (_, i) => ({ ...cue, id: String(i) })));
  let calls = 0;
  // AbortSignal.timeout uses an unref'd timer; hold the test loop open like a real fetch socket would.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(translateBatches(batches, { apiKey: 'k', batchTimeoutMs: 15, fetchImpl: (_, { signal }) => {
      calls++;
      return waitForAbort(signal);
    } }), { name: 'TimeoutError' });
    assert.equal(calls, 1);
  } finally { clearTimeout(keepAlive); }
});

test('overall translation timeout returns 504; client disconnect aborts an in-flight provider request', async t => {
  const timed = await setup(t, { translationTimeoutMs: 25, translationFetch: (_, { signal }) => waitForAbort(signal) });
  const response = await timed.post({ cues: [cue] });
  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), { error: '翻译超时，请重试' });

  const started = Promise.withResolvers();
  const stopped = Promise.withResolvers();
  const disconnected = await setup(t, { translationFetch: (_, { signal }) => {
    started.resolve();
    return waitForAbort(signal).finally(() => stopped.resolve(signal.reason));
  } });
  const controller = new AbortController();
  const post = disconnected.post({ cues: [cue] }, { signal: controller.signal });
  await started.promise;
  controller.abort();
  await assert.rejects(post, { name: 'AbortError' });
  assert.equal((await stopped.promise).name, 'AbortError');
});
