import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createServer } from '../agent/server.mjs';
const document = { context: { bvid: 'BVtest' }, cues: [{ id: 'c1', speakerId: '0', text: '原始句子', startMs: 0, endMs: 100 }], paragraphs: [], raw: { keep: true } };
const result = { speakers: { '0': '未知发言人' }, summary: '摘要' };
async function setup(t, options = {}) {
  const root = options.root || await mkdtemp(join(tmpdir(), 'pi-agent-test-'));
  const server = await createServer({ root, port: 0, apiKey: 'provider-secret', ...options });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.close(); server.closeAllConnections(); });
  const url = server.connection.url;
  const headers = { Authorization: `Bearer ${server.connection.token}` };
  const request = (path, options = {}) => fetch(url + path, { ...options, headers: { ...headers, ...options.headers } });
  const create = async () => { const response = await request('/tasks', { method: 'POST', body: JSON.stringify({ document, mode: 'analyze' }) }); assert.equal(response.status, 202); return response.json(); };
  return { server, root, request, create, url, headers };
}
async function complete(request, id) {
  const response = await request(`/tasks/${id}/events`);
  const text = await response.text();
  const task = await (await request(`/tasks/${id}`)).json();
  return { task, text };
}

test('HTTP token, exact Host, extension-only Origin, preflight and validation', async t => {
  const app = await setup(t, { runner: async () => result });
  assert.equal((await fetch(app.url + '/tasks')).status, 401);
  assert.equal((await app.request('/tasks', { headers: { Origin: 'https://evil.test' } })).status, 403);
  assert.equal((await app.request('/tasks', { headers: { Origin: 'chrome-extension://invalid' } })).status, 403);
  const origin = 'chrome-extension://' + 'a'.repeat(32);
  const allowed = await app.request('/tasks', { method: 'OPTIONS', headers: { Origin: origin } });
  assert.equal(allowed.status, 204); assert.equal(allowed.headers.get('access-control-allow-origin'), origin);
  assert.equal((await fetch(app.url + '/tasks', { headers: { Origin: origin } })).status, 401);
  const badHost = await new Promise(resolve => { const req = http.request(app.url + '/tasks', { headers: { ...app.headers, Host: '127.0.0.1.attacker.test:43127' } }, response => { response.resume(); resolve(response.statusCode); }); req.end(); });
  assert.equal(badHost, 403);
  assert.equal((await app.request('/tasks', { method: 'POST', body: '{}' })).status, 400);
  const connection = JSON.parse(await readFile(join(app.root, '.private/agent/connection.json'), 'utf8'));
  assert.equal(connection.token, app.server.connection.token);
  assert.equal((await stat(join(app.root, '.private/agent/connection.json'))).mode & 0o777, 0o600);
});

test('HTTP persistence, messages, SSE event ids/replay, original document retained', async t => {
  const app = await setup(t, { runner: async ({ onEvent, onMessages }) => {
    await onEvent({ type: 'message_end', message: { role: 'assistant', errorMessage: 'provider-secret /private/path', content: [] } });
    await onMessages([{ role: 'assistant', errorMessage: 'provider-secret', content: [{ type: 'text', text: 'provider-secret' }] }]);
    return result;
  } });
  const { id } = await app.create();
  const { task, text } = await complete(app.request, id);
  assert.equal(task.status, 'completed'); assert.deepEqual(task.document, document);
  assert.deepEqual(task.result, result);
  assert.ok(!text.includes('provider-secret')); assert.ok(!text.includes('/private/path'));
  const frames = text.split('\n\n').filter(frame => frame.startsWith('id:'));
  const ids = frames.map(frame => Number(frame.match(/^id: (\d+)/)[1]));
  assert.deepEqual(ids, ids.map((_, index) => index + 1));
  const replay = await (await app.request(`/tasks/${id}/events`, { headers: { 'Last-Event-ID': '2' } })).text();
  assert.ok(!replay.includes('id: 1\n')); assert.ok(!replay.includes('id: 2\n')); assert.ok(replay.includes('event: status'));
  const saved = JSON.parse(await readFile(join(app.root, `.private/agent/tasks/${id}.json`), 'utf8'));
  assert.deepEqual(saved.document, document);
  const messages = await readFile(join(app.root, `.private/agent/tasks/${id}.messages.json`), 'utf8');
  assert.ok(!messages.includes('provider-secret'));
});

test('cancel and timeout are terminal even if runner returns late', async t => {
  for (const status of ['cancelled', 'timed_out']) {
    let release; let started;
    const begun = new Promise(resolve => { started = resolve; });
    const app = await setup(t, { timeoutMs: 25, runner: ({ signal }) => new Promise(resolve => { release = () => resolve(result); started(signal); }) });
    const { id } = await app.create();
    const signal = await begun;
    if (status === 'cancelled') await app.request(`/tasks/${id}/cancel`, { method: 'POST' });
    const { task } = await complete(app.request, id);
    assert.equal(task.status, status); assert.ok(signal.aborted); assert.equal(task.result, undefined);
    release(); await new Promise(resolve => setImmediate(resolve));
    const final = await (await app.request(`/tasks/${id}`)).json();
    assert.equal(final.status, status); assert.equal(final.result, undefined);
  }
});

test('provider errors are fixed safe errors, invalid injected results fail', async t => {
  for (const runner of [async () => { throw new Error('provider-secret https://secret.test /Users/private'); }, async () => ({ ...result, speakers: [] })]) {
    const app = await setup(t, { runner }); const { id } = await app.create();
    const { task, text } = await complete(app.request, id);
    assert.equal(task.status, 'failed'); assert.equal(task.result, undefined);
    assert.ok(!JSON.stringify(task).includes('provider-secret')); assert.ok(!text.includes('/Users/private'));
  }
});

test('context/audio HTTP flow persists transcription before analysis and hides keys', async t => {
  let asrCalls = 0;
  let analysisCalls = 0;
  const app = await setup(t, { bailianApiKey: 'bailian-secret', asrRunner: async ({ audioPath, context, apiKey }) => {
    asrCalls++;
    assert.equal(apiKey, 'bailian-secret');
    assert.deepEqual(context, { bvid: 'BVtest', title: '视频', cid: 123 });
    assert.deepEqual(await readFile(audioPath), Buffer.from([0, 1, 2, 255]));
    assert.equal((await stat(audioPath)).mode & 0o777, 0o600);
    return { ...document, context, raw: { provider: 'bailian-secret', keep: true } };
  }, runner: async ({ document: prepared }) => {
    analysisCalls++;
    assert.deepEqual(prepared.raw, { provider: '[已隐藏]', keep: true });
    assert.deepEqual(prepared.cues, document.cues);
    return result;
  } });
  const created = await app.request('/tasks', { method: 'POST', body: JSON.stringify({ context: { bvid: 'BVtest', title: '视频', cid: 123 }, mode: 'analyze' }) });
  const { id, status } = await created.json();
  assert.equal(status, 'receiving_audio'); assert.equal(asrCalls, 0); assert.equal(analysisCalls, 0);
  assert.equal((await app.request(`/tasks/${id}/audio`, { method: 'POST', body: 'audio' })).status, 415);
  const uploaded = await app.request(`/tasks/${id}/audio`, { method: 'POST', headers: { 'Content-Type': 'audio/mp4' }, body: Buffer.from([0, 1, 2, 255]) });
  assert.equal(uploaded.status, 202); assert.deepEqual(await uploaded.json(), { id, received: true, size: 4 });
  const { task, text } = await complete(app.request, id);
  assert.equal(task.status, 'completed'); assert.equal(asrCalls, 1); assert.equal(analysisCalls, 1);
  assert.ok(text.includes('receiving_audio')); assert.ok(text.includes('transcribing')); assert.ok(text.includes('analyzing'));
  assert.ok(!JSON.stringify(task).includes('bailian-secret')); assert.ok(!text.includes('bailian-secret'));
  assert.equal((await app.request(`/tasks/${id}/audio`, { method: 'POST', headers: { 'Content-Type': 'audio/mp4' }, body: 'x' })).status, 409);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await readdir(join(app.root, '.private/agent/uploads')), []);
});

test('audio upload rejects oversized/empty bodies and cancelled tasks without calling ASR', async t => {
  const app = await setup(t, { maxAudioBytes: 3, asrRunner: () => { assert.fail('ASR must not start'); } });
  const { id } = await (await app.request('/tasks', { method: 'POST', body: JSON.stringify({ context: {}, mode: 'analyze' }) })).json();
  const upload = body => app.request(`/tasks/${id}/audio`, { method: 'POST', headers: { 'Content-Type': 'audio/mp4' }, body });
  assert.equal((await upload('1234')).status, 413);
  assert.equal((await upload('')).status, 400);
  assert.deepEqual(await readdir(join(app.root, '.private/agent/uploads')), []);
  await app.request(`/tasks/${id}/cancel`, { method: 'POST' });
  assert.equal((await upload('12')).status, 409);
  const bad = await app.request('/tasks', { method: 'POST', body: JSON.stringify({ context: {}, audio: 'base64', mode: 'analyze' }) });
  assert.equal(bad.status, 400);
});

test('cancelling ASR prevents late document and analysis, errors stay private', async t => {
  let release;
  let begun;
  const started = new Promise(resolve => { begun = resolve; });
  const app = await setup(t, { asrRunner: ({ signal }) => new Promise(resolve => { release = resolve; begun(signal); }), runner: () => assert.fail('analysis must not start') });
  const { id } = await (await app.request('/tasks', { method: 'POST', body: JSON.stringify({ context: {}, mode: 'analyze' }) })).json();
  await app.request(`/tasks/${id}/audio`, { method: 'POST', headers: { 'Content-Type': 'audio/mp4' }, body: '12' });
  const signal = await started;
  await app.request(`/tasks/${id}/cancel`, { method: 'POST' });
  assert.ok(signal.aborted);
  release(document);
  const { task } = await complete(app.request, id);
  assert.equal(task.status, 'cancelled'); assert.equal(task.document, undefined);
});

test('ASR errors and timeout cannot launch analysis or expose credentials', async t => {
  for (const timeout of [false, true]) {
    const app = await setup(t, { bailianApiKey: 'bailian-private', asrTimeoutMs: 15,
      asrRunner: async ({ signal }) => {
        if (!timeout) throw new Error('bailian-private /private/provider/path');
        await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }, runner: () => assert.fail('analysis must not start') });
    const { id } = await (await app.request('/tasks', { method: 'POST', body: JSON.stringify({ context: {}, mode: 'analyze' }) })).json();
    await app.request(`/tasks/${id}/audio`, { method: 'POST', headers: { 'Content-Type': 'audio/mp4' }, body: '12' });
    const { task, text } = await complete(app.request, id);
    assert.equal(task.status, timeout ? 'timed_out' : 'failed');
    assert.equal(task.document, undefined); assert.ok(!text.includes('bailian-private')); assert.ok(!text.includes('/private/provider/path'));
  }
});

test('restart loads completed tasks, rotates token and fails interrupted tasks', async t => {
  const app = await setup(t, { runner: async () => result });
  const { id } = await app.create(); await complete(app.request, id);
  const path = join(app.root, `.private/agent/tasks/${id}.json`);
  const interrupted = JSON.parse(await readFile(path, 'utf8')); interrupted.status = 'running';
  await writeFile(path, JSON.stringify(interrupted));
  const restarted = await setup(t, { root: app.root, runner: async () => result });
  assert.notEqual(restarted.server.connection.token, app.server.connection.token);
  const task = await (await restarted.request(`/tasks/${id}`)).json();
  assert.equal(task.status, 'failed'); assert.equal(task.result, undefined);
});
