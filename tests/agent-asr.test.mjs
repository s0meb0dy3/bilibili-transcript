import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ASR_MODEL, loadBailianApiKey, transcribeAudioFile } from '../agent/asr-service.mjs';

const raw = { transcripts: [{ sentences: [
  { begin_time: 100, end_time: 200, text: '第二句', speaker_id: 1 },
  { begin_time: 0, end_time: 100, text: '第一句', speaker_id: 0, words: [{ text: '第一句' }] }
] }] };

test('Bailian env keys and quoted .env values are loaded server-side', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-asr-key-'));
  await writeFile(join(root, '.env'), 'export BAILIAN_KEY="alias"\nBAILIAN_API_KEY=primary # comment\n');
  assert.equal(await loadBailianApiKey(root, {}), 'primary');
  assert.equal(await loadBailianApiKey(root, { BAILIAN_KEY: 'environment' }), 'environment');
  assert.equal(await loadBailianApiKey(root, { BAILIAN_API_KEY: 'preferred', BAILIAN_KEY: 'alias' }), 'preferred');
});

test('ASR policy/OSS/submit/poll/result uses fixed model and keeps raw plus normalized cues', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-asr-flow-'));
  const audioPath = join(root, 'audio.m4a');
  await writeFile(audioPath, Buffer.from([1, 2, 3]));
  let count = 0;
  const document = await transcribeAudioFile({ audioPath, context: { bvid: 'BVtest' }, apiKey: 'test-key', pollIntervalMs: 0, fetchImpl: async (url, options) => {
    assert.equal(options.redirect, 'error');
    count++;
    if (count === 1) {
      assert.ok(url.includes(`model=${ASR_MODEL}`));
      assert.equal(options.headers.Authorization, 'Bearer test-key');
      return Response.json({ data: { upload_host: 'https://bucket.oss-cn-beijing.aliyuncs.com', upload_dir: 'uploads', oss_access_key_id: 'id', signature: 'sig', policy: 'policy' } });
    }
    if (count === 2) {
      assert.equal(options.headers, undefined);
      assert.equal(options.body.get('file').size, 3);
      assert.equal(options.body.get('file').name, 'audio.m4a');
      return new Response('');
    }
    if (count === 3) {
      const submitted = JSON.parse(options.body);
      assert.equal(submitted.model, ASR_MODEL); assert.match(submitted.input.file_urls[0], /^oss:\/\/uploads\/.+\.m4a$/);
      assert.equal(options.headers['X-DashScope-Async'], 'enable');
      return Response.json({ output: { task_id: 'task-id' } });
    }
    if (count === 4) return Response.json({ output: { task_status: 'RUNNING' } });
    if (count === 5) return Response.json({ output: { task_status: 'SUCCEEDED', results: [{ transcription_url: 'https://result.aliyuncs.com/raw.json' }] } });
    assert.equal(count, 6); assert.equal(options.headers, undefined);
    return Response.json(raw);
  } });
  assert.deepEqual(document.raw, raw);
  assert.deepEqual(document.cues.map(cue => [cue.id, cue.text, cue.speakerId]), [['1', '第一句', '0'], ['2', '第二句', '1']]);
  assert.equal(document.paragraphs.length, 2); assert.deepEqual(document.context, { bvid: 'BVtest' });
});

test('ASR rejects missing keys and non-Aliyun policy hosts', async () => {
  await assert.rejects(transcribeAudioFile({ audioPath: 'unused' }), /未配置/);
  await assert.rejects(transcribeAudioFile({ audioPath: 'unused', apiKey: 'key', fetchImpl: async () => Response.json({ data: { upload_host: 'https://evil.test', upload_dir: 'x', oss_access_key_id: 'id', signature: 'sig', policy: 'policy' } }) }), /云端资源/);
});
