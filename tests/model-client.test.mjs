import test from 'node:test';
import assert from 'node:assert/strict';
import { getModelConfig, completeText, analyzeFrame } from '../extension/model-client.js';

test('模型网关统一解包配置、文本和视觉响应', async () => {
  const previous = globalThis.chrome;
  const calls = [];
  globalThis.chrome = { runtime: { sendMessage: async message => {
    calls.push(message);
    return { ok: true, data: { action: message.action } };
  } } };
  try {
    assert.deepEqual(await getModelConfig(), { action: 'modelConfig' });
    assert.deepEqual(await completeText({ model: 'text' }), { action: 'complete' });
    assert.deepEqual(await analyzeFrame({ model: 'vision' }), { action: 'vision' });
    assert.deepEqual(calls.map(call => call.action), ['modelConfig', 'complete', 'vision']);
    assert.equal(calls[1].request.model, 'text');
  } finally { globalThis.chrome = previous; }
});

test('网关传递错误，取消后拒绝迟到模型结果', async () => {
  const previous = globalThis.chrome;
  const controller = new AbortController();
  globalThis.chrome = { runtime: { sendMessage: async () => ({ ok: false, error: '服务失败' }) } };
  try {
    await assert.rejects(completeText({}), /服务失败/);
    globalThis.chrome.runtime.sendMessage = async () => {
      controller.abort();
      return { ok: true, data: 'late' };
    };
    await assert.rejects(analyzeFrame({}, { signal: controller.signal }), { name: 'AbortError' });
    globalThis.chrome.runtime.sendMessage = () => assert.fail('取消后不应请求');
    await assert.rejects(getModelConfig(controller.signal), { name: 'AbortError' });
  } finally { globalThis.chrome = previous; }
});
