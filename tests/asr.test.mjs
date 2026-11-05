import test from 'node:test';
import assert from 'node:assert/strict';
import { transcribeAudio } from '../extension/asr.js';

const API = 'https://dashscope.aliyuncs.com/api/v1';
const audioUrl = 'https://upos-sz-mirrorcos.bilivideo.com/audio.m4a?token=private-audio';
const uploadHost = 'https://dashscope-file.oss-cn-beijing.aliyuncs.com';
const resultUrl = `${uploadHost}/result.json?signature=private-result`;
const apiKey = 'test-api-key-do-not-forward';
const raw = { transcripts: [{ sentences: [{ text: '原始结果', speaker_id: 0 }] }] };
const ok = body => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

function fixture(initial = null) {
  let saved = initial;
  const writes = [];
  const calls = [];
  const store = {
    get: async key => { assert.equal(key, 'video:part:model'); return saved; },
    set: async (key, value) => {
      assert.equal(key, 'video:part:model');
      writes.push(value);
      saved = value;
    }
  };
  const routes = [
    () => new Response(new Blob(['original-m4a-bytes'], { type: 'audio/mp4' })),
    () => ok({ data: {
      upload_host: uploadHost, upload_dir: 'temporary/dir',
      oss_access_key_id: 'oss-id', signature: 'oss-signature', policy: 'private-policy',
      x_oss_object_acl: 'private', x_oss_forbid_overwrite: 'true'
    } }),
    () => new Response(null, { status: 200 }),
    () => ok({ output: { task_id: 'task-123' } }),
    () => ok({ output: { task_status: 'SUCCEEDED', results: [{ transcription_url: resultUrl }] } }),
    () => ok(raw)
  ];
  const fetchImpl = async (url, options) => {
    calls.push({ url, ...options });
    assert.ok(routes.length, `Unexpected fetch: ${new URL(url).origin}`);
    return routes.shift()(url, options);
  };
  return {
    calls, writes, routes, store,
    options: { audioUrl, config: { apiKey }, fetchImpl, store, taskKey: 'video:part:model' }
  };
}

test('uploads original m4a MIME and bytes with OSS fields, then caches raw JSON', async () => {
  const f = fixture();
  const events = [];
  assert.deepEqual(await transcribeAudio({ ...f.options, onProgress: e => events.push(e) }), raw);
  assert.equal(f.calls.length, 6);
  assert.equal(f.calls[1].url, `${API}/uploads?action=getPolicy&model=qwen-audio-3.1-asr-flash-filetrans`);
  const form = f.calls[2].body;
  for (const name of ['OSSAccessKeyId', 'Signature', 'policy', 'key', 'success_action_status', 'x-oss-object-acl', 'x-oss-forbid-overwrite']) {
    assert.ok(form.has(name), name);
  }
  assert.equal(form.get('file').type, 'audio/mp4');
  assert.equal(form.get('file').name, 'audio.m4a');
  assert.equal(await form.get('file').text(), 'original-m4a-bytes');
  const submitted = JSON.parse(f.calls[3].body);
  assert.deepEqual(submitted.parameters, { channel_id: [0], diarization_enabled: true });
  assert.equal(submitted.input.file_urls[0], `oss://${form.get('key')}`);
  assert.equal(f.calls[3].headers['X-DashScope-Async'], 'enable');
  assert.equal(f.calls[3].headers['X-DashScope-OssResourceResolve'], 'enable');
  for (const call of f.calls) {
    assert.equal(call.redirect, 'error');
    assert.equal(call.credentials, 'omit');
    if (new URL(call.url).hostname === 'dashscope.aliyuncs.com') {
      assert.equal(call.headers.Authorization, `Bearer ${apiKey}`);
    } else assert.equal(call.headers?.Authorization, undefined);
  }
  assert.deepEqual(f.writes, [{ task_id: 'task-123' }, { task_id: 'task-123', raw }]);
  const persisted = JSON.stringify(f.writes);
  for (const secret of [apiKey, audioUrl, 'private-policy', resultUrl]) assert.ok(!persisted.includes(secret));
  assert.deepEqual(events.map(e => e.stage), ['downloading', 'uploading', 'submitting', 'polling', 'completed']);
  assert.deepEqual(await transcribeAudio(f.options), raw);
  assert.equal(f.calls.length, 6, 'cached result avoids all network calls');
});

test('restores task without reading expired audio URL or uploading again', async () => {
  const f = fixture({ task_id: 'task-123' });
  f.routes.splice(0, 4);
  assert.deepEqual(await transcribeAudio({ ...f.options, audioUrl: 'expired' }), raw);
  assert.equal(f.calls[0].url, `${API}/tasks/task-123`);
  assert.equal(f.calls.length, 2);
});

test('abort preserves submitted task, and next call resumes it', async () => {
  const f = fixture();
  const controller = new AbortController();
  f.routes[4] = () => {
    controller.abort(new Error(`untrusted ${apiKey} ${resultUrl}`));
    throw controller.signal.reason;
  };
  await assert.rejects(transcribeAudio({ ...f.options, signal: controller.signal }), error => {
    assert.equal(error.name, 'AbortError');
    assert.ok(!error.message.includes(apiKey));
    assert.ok(!error.message.includes(resultUrl));
    return true;
  });
  assert.deepEqual(f.writes, [{ task_id: 'task-123' }]);
  f.routes.unshift(() => ok({ output: { task_status: 'SUCCEEDED', results: [{ transcription_url: resultUrl }] } }));
  assert.deepEqual(await transcribeAudio(f.options), raw);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 2);
});

test('polls at three seconds and timeout retains resumable task', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture({ task_id: 'task-123' });
  f.routes.splice(0, f.routes.length, () => ok({ output: { task_status: 'RUNNING' } }));
  const pending = transcribeAudio(f.options);
  const rejection = assert.rejects(pending, /30 分钟/);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(f.calls.length, 1);
  t.mock.timers.tick(2999);
  assert.equal(f.calls.length, 1);
  t.mock.timers.tick(30 * 60 * 1000);
  await rejection;
  assert.equal(f.writes.length, 0);
});

test('pending task polls again after three seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture({ task_id: 'task-123' });
  f.routes.splice(0, 4, () => ok({ output: { task_status: 'PENDING' } }));
  const pending = transcribeAudio(f.options);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  t.mock.timers.tick(2999);
  assert.equal(f.calls.length, 1);
  t.mock.timers.tick(1);
  assert.deepEqual(await pending, raw);
  assert.equal(f.calls.length, 3);
});

test('failed task clears cache so explicit retry creates new task', async () => {
  const f = fixture({ task_id: 'failed-task' });
  f.routes.unshift(() => ok({ output: { task_status: 'FAILED', message: `${apiKey} ${resultUrl}` } }));
  await assert.rejects(transcribeAudio(f.options), /任务失败/);
  assert.deepEqual(f.writes, [null]);
  assert.equal(f.calls.length, 1, 'no automatic charged retry');
  assert.deepEqual(await transcribeAudio(f.options), raw);
});

test('network errors hide secrets and preserve task for manual resume', async () => {
  const f = fixture({ task_id: 'task-123' });
  f.routes.unshift(() => { throw new Error(`${apiKey} ${resultUrl}`); });
  await assert.rejects(transcribeAudio(f.options), error => {
    assert.ok(!error.message.includes(apiKey));
    assert.ok(!error.message.includes(resultUrl));
    return /网络请求失败/.test(error.message);
  });
  assert.deepEqual(f.writes, []);
  assert.equal(f.calls.length, 1);
});

test('rejects untrusted audio hosts, deceptive suffixes, credentials and protocols', async () => {
  for (const url of ['https://bilivideo.com.evil.test/a', 'file:///a.m4a', 'https://user:pass@bilivideo.com/a', 'https://evil.test/a', 'https://bilivideo.com:8443/a']) {
    const f = fixture();
    await assert.rejects(transcribeAudio({ ...f.options, audioUrl: url }), /地址|域名/);
    assert.equal(f.calls.length, 0);
  }
});

test('rejects unsafe OSS upload policy without forwarding credentials', async () => {
  for (const host of ['http://bucket.aliyuncs.com', 'https://aliyuncs.com.evil.test', 'https://evil.test']) {
    const f = fixture();
    f.routes[1] = () => ok({ data: {
      upload_host: host, upload_dir: 'dir', oss_access_key_id: 'id', signature: 'secret', policy: 'private-policy'
    } });
    await assert.rejects(transcribeAudio(f.options), /域名/);
    assert.equal(f.calls.length, 2);
  }
});

test('rejects non-HTTPS or external transcription URL before fetching', async () => {
  for (const url of ['http://bucket.aliyuncs.com/result', 'https://evil.test/result?secret=private']) {
    const f = fixture({ task_id: 'task-123' });
    f.routes.splice(0, f.routes.length, () => ok({ output: { task_status: 'SUCCEEDED', results: [{ transcription_url: url }] } }));
    await assert.rejects(transcribeAudio(f.options), error => /域名/.test(error.message) && !error.message.includes(url));
    assert.equal(f.calls.length, 1);
    assert.equal(f.writes.length, 0);
  }
});

test('rejects oversized audio before asking for upload policy', async () => {
  const f = fixture();
  const big = { size: 2 * 1024 ** 3 + 1, type: 'audio/mp4' };
  await assert.rejects(transcribeAudio({ ...f.options, loadAudio: async () => big }), /2GB/);
  assert.equal(f.calls.length, 0);
});

test('already cancelled request performs no fetch or persistence', async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(transcribeAudio({ ...f.options, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(f.calls.length, 0);
  assert.equal(f.writes.length, 0);
});
