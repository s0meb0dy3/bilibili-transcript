import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentClient } from '../extension/agent-client.js';

test('Agent客户端固定本机地址并通过header鉴权，不把凭据放入URL', async () => {
  const calls = [];
  const client = createAgentClient({ token: 'private-token', fetchImpl: async (url, options) => {
    calls.push({ url, options }); return Response.json({ id: 'task', status: 'queued' });
  } });
  await client.start({ cues: [] }); await client.get('task'); await client.cancel('task');
  assert.deepEqual(calls.map(call => call.url), ['http://127.0.0.1:43127/tasks', 'http://127.0.0.1:43127/tasks/task', 'http://127.0.0.1:43127/tasks/task/cancel']);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer private-token');
  assert.equal(JSON.parse(calls[0].options.body).mode, 'analyze');
});

test('SSE能跨网络分块读取中文，忽略heartbeat并逐条解码JSON', async () => {
  const encoded = new TextEncoder().encode(': heartbeat\n\nid: 1\ndata: {"type":"status","data":{"status":"处理中"}}\n\nid: 2\ndata: {"type":"status","data":{"status":"completed"}}\n\n');
  const chunks = [encoded.slice(0, 60), encoded.slice(60, 63), encoded.slice(63)];
  const stream = new ReadableStream({ pull(controller) { if (chunks.length) controller.enqueue(chunks.shift()); else controller.close(); } });
  const client = createAgentClient({ token: 'token', fetchImpl: async () => new Response(stream) });
  const events = []; await client.watch('task', event => events.push(event));
  assert.equal(events.length, 2); assert.equal(events[0].data.status, '处理中');
});

test('无连接凭据与HTTP失败给出安全错误', async () => {
  await assert.rejects(createAgentClient({ fetchImpl: async () => { throw new Error('offline'); } }).get('task'), /本地 Agent/);
  await assert.rejects(createAgentClient({ token: 'secret', fetchImpl: async () => new Response('private error', { status: 401 }) }).get('task'), /HTTP 401/);
});


test('自动连接后复用凭据并二进制上传音频，不发送provider密钥', async () => {
  const calls = [];
  const client = createAgentClient({ fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return Response.json(url.endsWith('/connection') ? { token: 'session-token' } : { id: 'new-task' });
  } });
  await client.startContext({ key: 'BV:1' });
  const audio = new Blob(['audio'], { type: 'video/mp4' });
  await client.uploadAudio('new-task', audio);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer session-token');
  assert.equal(calls[2].options.headers.Authorization, 'Bearer session-token');
  assert.equal(calls[2].options.body, audio);
  assert.equal(calls[2].options.headers['Content-Type'], 'audio/mp4');
  assert.deepEqual(JSON.parse(calls[1].options.body).context, { key: 'BV:1' });
});
