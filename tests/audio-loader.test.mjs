import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPageAudio } from '../extension/audio-loader.js';

const context = { tabId: 10, key: 'BVtest:1' };
function downloader(chunks, size = chunks.join('').length) {
  const calls = [];
  return { calls, request: async (action, payload) => {
    calls.push({ action, payload });
    if (action === 'audioInfo') return { size, type: 'audio/mp4' };
    return { base64: btoa(chunks.shift()), done: !chunks.length };
  } };
}

test('页面音频按片拼接，保留目标标签页、MIME和原始字节', async () => {
  const { request, calls } = downloader(['abc', 'defg']);
  const audio = await loadPageAudio({ request, context });
  assert.equal(await audio.text(), 'abcdefg');
  assert.equal(audio.type, 'audio/mp4');
  assert.deepEqual(calls.map(call => call.payload), [
    context, { ...context, offset: 0 }, { ...context, offset: 3 }
  ]);
});

test('空分片和提前结束会失败，不上传损坏音频', async () => {
  await assert.rejects(loadPageAudio({ ...downloader([''], 3), context }), /分片为空/);
  await assert.rejects(loadPageAudio({ ...downloader(['abc'], 5), context }), /不完整/);
});

test('已取消不下载，下载期间取消不继续请求下一片', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(loadPageAudio({ context, signal: controller.signal,
    request: () => assert.fail('不应请求') }), { name: 'AbortError' });
  const next = new AbortController();
  let count = 0;
  await assert.rejects(loadPageAudio({ context, signal: next.signal, request: async () => {
    count++;
    next.abort();
    return { size: 3 };
  } }), { name: 'AbortError' });
  assert.equal(count, 1);
});
