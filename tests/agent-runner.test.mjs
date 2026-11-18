import test from 'node:test';
import assert from 'node:assert/strict';
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } from '@earendil-works/pi-ai';
import { runPiTask, createDeepSeekRuntime, loadApiKey } from '../agent/runner.mjs';
import { prepareDocument, validateResult } from '../agent/document.mjs';

export const document = { context: { bvid: 'BVtest', title: '测试视频', description: '节目简介', uploader: { name: '测试UP主', bio: '主持栏目' } }, cues: [{ id: 'c1', speakerId: '0', startMs: 0, endMs: 1000, text: '你好，我是主持人。' }, { id: 'c2', speakerId: '1', startMs: 1000, endMs: 2000, text: '大家好。' }], paragraphs: [], raw: { original: true } };
const result = { speakers: { '0': '主持人', '1': '未知发言人' }, summary: '相互问候' };
function runtime(responses) {
  const faux = fauxProvider();
  faux.setResponses(responses);
  const models = createModels(); models.setProvider(faux.provider);
  const contexts = [];
  return { faux, contexts, runtime: { model: faux.getModel(), streamFn: (model, context, options) => { contexts.push(structuredClone(context)); return models.streamSimple(model, context, options); } } };
}
const call = (name, args) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' });

test('首轮传入完整转写及资料，按需搜索后修正提交', async () => {
  const invalid = { ...result, speakers: { '0': '主持人' } };
  const script = runtime([call('web_search', { query: '测试节目 嘉宾' }), call('finalize_video_result', invalid), call('finalize_video_result', result), fauxAssistantMessage([fauxText('不应继续')])]);
  const queries = [];
  const output = await runPiTask({ document, runtime: script.runtime, webSearch: async query => {
    queries.push(query); return [{ title: '节目嘉宾', url: 'https://example.com' }];
  } });
  assert.deepEqual(output, result);
  assert.deepEqual(queries, ['测试节目 嘉宾']);
  assert.equal(script.faux.getPendingResponseCount(), 1);
  assert.deepEqual(script.contexts[0].messages.flatMap(message => message.toolsAdded || []).map(tool => tool.name), ['web_search', 'finalize_video_result']);
  const first = script.contexts[0].messages.find(message => message.role === 'user');
  const input = JSON.parse(first.content[0].text);
  assert.deepEqual(input.context, document.context);
  assert.deepEqual(input.cues, document.cues);
  assert.ok(script.contexts[1].messages.some(message => message.role === 'toolResult' && message.toolName === 'web_search'));
  assert.ok(script.contexts[2].messages.some(message => message.role === 'toolResult' && message.toolName === 'finalize_video_result' && message.isError));
});

test('没有搜索配置时只暴露提交工具，首轮可以直接完成', async () => {
  const script = runtime([call('finalize_video_result', result)]);
  assert.deepEqual(await runPiTask({ document, runtime: script.runtime }), result);
  assert.deepEqual(script.contexts[0].messages.flatMap(message => message.toolsAdded || []).map(tool => tool.name), ['finalize_video_result']);
});

test('Pi 同批提交成功后不再执行搜索', async () => {
  const script = runtime([fauxAssistantMessage([fauxToolCall('finalize_video_result', result), fauxToolCall('web_search', { query: '节目' })], { stopReason: 'toolUse' })]);
  let searches = 0;
  await runPiTask({ document, runtime: script.runtime, webSearch: async () => ++searches });
  assert.equal(searches, 0);
  assert.equal(script.faux.state.callCount, 1);
});

test('轮次与工具预算仍然生效', async () => {
  const turns = runtime([fauxAssistantMessage([fauxText('不提交')]), fauxAssistantMessage([fauxText('不提交')])]);
  await assert.rejects(runPiTask({ document, runtime: turns.runtime, maxTurns: 2 }));
  assert.equal(turns.faux.state.callCount, 2);
  const tools = runtime([call('web_search', { query: '节目' }), call('finalize_video_result', result)]);
  await assert.rejects(runPiTask({ document, runtime: tools.runtime, webSearch: async () => [], maxToolCalls: 1 }));
});

test('校验拒绝缺失、多出或空白的说话人标签与空摘要', () => {
  const prepared = prepareDocument(document);
  for (const speakers of [{ '0': '主持人' }, { ...result.speakers, '2': '来宾' }, { ...result.speakers, '1': ' ' }]) {
    assert.throws(() => validateResult({ ...result, speakers }, prepared), /全部/);
  }
  assert.throws(() => validateResult({ ...result, summary: ' ' }, prepared), /summary/);
});

test('DeepSeek runtime pins provider URL/model and resolves env without exposing keys', async () => {
  const runtime = createDeepSeekRuntime('test-secret');
  assert.equal(runtime.model.id, 'deepseek-flash');
  assert.equal(runtime.model.provider, 'deepseek');
  assert.equal(runtime.model.baseUrl, 'https://api.deepseek.com');
  assert.equal(await loadApiKey('/unused', { API_KEY: 'generic' }), 'generic');
  assert.equal(await loadApiKey('/unused', { API_KEY: 'generic', DEEPSEEK_API_KEY: 'specific' }), 'specific');
});
