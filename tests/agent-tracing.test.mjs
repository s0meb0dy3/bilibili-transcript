import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { createServer } from '../agent/server.mjs';
import { initializeTracing } from '../agent/tracing.mjs';
import { runPiTask } from '../agent/runner.mjs';

test('HTTP 任务通过 Langfuse SDK 导出分层观测，不上传敏感正文', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agent-tracing-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requests = [];
  const receiver = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    requests.push({ path: req.url, version: req.headers['x-langfuse-ingestion-version'],
      payload: JSON.parse(req.headers['content-encoding'] === 'gzip' ? gunzipSync(body) : body) });
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
  });
  receiver.listen(0, '127.0.0.1'); await once(receiver, 'listening');
  t.after(() => receiver.close());
  const url = `http://127.0.0.1:${receiver.address().port}`;
  await writeFile(join(root, '.env'), `LANGFUSE_BASE_URL=${url}\nLANGFUSE_PUBLIC_KEY=pk-test\nLANGFUSE_SECRET_KEY=sk-trace-test\n`);
  const tracing = initializeTracing(root, {});
  const faux = fauxProvider();
  const model = faux.getModel();
  const models = createModels(); models.setProvider(faux.provider);
  const result = { speakers: { '0': '主持人' }, summary: 'PRIVATE_SUMMARY' };
  const call = (name, args) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' });
  faux.setResponses([call('web_search', { query: 'PRIVATE_QUERY' }), call('finalize_video_result', result)]);
  const document = { context: { title: 'PRIVATE_TITLE' }, cues: [{ id: '1', speakerId: '0', startMs: 0, endMs: 100, text: 'PRIVATE_TRANSCRIPT' }] };
  const app = await createServer({ root, tracing, apiKey: 'sk-provider-test', asrRunner: async () => document, runner: options => runPiTask({
    ...options, webSearch: async () => [{ title: 'PRIVATE_SEARCH_RESULT' }],
    runtime: { model, streamFn: (...args) => models.streamSimple(...args) }
  }) });
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  t.after(() => { app.close(); app.closeAllConnections(); });
  const request = (path, init = {}) => fetch(app.connection.url + path, { ...init, headers: { Authorization: `Bearer ${app.connection.token}` } });
  const created = await request('/tasks', { method: 'POST', body: JSON.stringify({ mode: 'analyze', context: document.context }) });
  assert.equal(created.status, 202);
  const { id } = await created.json();
  const upload = await fetch(`${app.connection.url}/tasks/${id}/audio`, {
    method: 'POST', headers: { Authorization: `Bearer ${app.connection.token}`, 'Content-Type': 'audio/mp4' }, body: 'PRIVATE_AUDIO'
  });
  assert.equal(upload.status, 202);
  await (await request(`/tasks/${id}/events`)).text();
  const task = await (await request(`/tasks/${id}`)).json();
  assert.deepEqual(task.result, result);
  await tracing.shutdown();
  assert.ok(requests.length);
  assert.ok(requests.every(req => req.path === '/api/public/otel/v1/traces' && req.version === '4'));
  const serialized = JSON.stringify(requests);
  assert.doesNotMatch(serialized, /PRIVATE_TRANSCRIPT|sk-provider-test|sk-trace-test/);
  assert.match(serialized, /PRIVATE_QUERY/);
  assert.match(serialized, /PRIVATE_SUMMARY/);
  const spans = requests.flatMap(req => req.payload.resourceSpans.flatMap(resource => resource.scopeSpans.flatMap(scope => scope.spans)));
  const rootSpan = spans.find(span => span.name === 'analyze-video');
  const agent = spans.find(span => span.name === 'analyze-transcript');
  assert.ok(rootSpan);
  assert.deepEqual(spans.filter(span => span.parentSpanId === rootSpan.spanId).map(span => span.name),
    ['receive-audio', 'transcribe-audio', 'analyze-transcript']);
  assert.equal(agent.parentSpanId, rootSpan.spanId);
  assert.deepEqual(spans.filter(span => span.parentSpanId === agent.spanId).map(span => span.name),
    ['turn-1', 'turn-2']);
  assert.deepEqual(spans.filter(span => span.name === 'turn-1').flatMap(turn => spans.filter(span => span.parentSpanId === turn.spanId).map(span => span.name)),
    ['generate-video-analysis', 'web_search']);
  assert.deepEqual(spans.filter(span => span.name === 'turn-2').flatMap(turn => spans.filter(span => span.parentSpanId === turn.spanId).map(span => span.name)),
    ['generate-video-analysis', 'finalize_video_result']);
  const generation = spans.find(span => span.name === 'generate-video-analysis');
  assert.ok(generation.attributes.some(({ key }) => key === 'langfuse.observation.usage_details'));
  assert.ok(spans.every(span => span.traceId === rootSpan.traceId));
});
