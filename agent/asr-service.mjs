import { openAsBlob } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { normalizeTranscript, paragraphize } from '../extension/transcript.js';

const API = 'https://dashscope.aliyuncs.com/api/v1';
export const ASR_MODEL = 'qwen-audio-3.1-asr-flash-filetrans';

export async function loadBailianApiKey(root = process.cwd(), env = process.env) {
  if (env.BAILIAN_API_KEY || env.BAILIAN_KEY) return env.BAILIAN_API_KEY || env.BAILIAN_KEY;
  let text;
  try { text = await readFile(join(root, '.env'), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?(BAILIAN_API_KEY|BAILIAN_KEY)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const value = match[2];
    values[match[1]] = /^(['"]).*\1$/.test(value) ? value.slice(1, -1) : value.replace(/\s+#.*$/, '');
  }
  return values.BAILIAN_API_KEY || values.BAILIAN_KEY;
}

function cloudUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !(url.hostname === 'aliyuncs.com' || url.hostname.endsWith('.aliyuncs.com'))) throw new Error('云端资源地址无效');
  return url.href;
}

// Audio stays on disk; openAsBlob streams the multipart file rather than reading 2GB into RAM.
export async function transcribeAudioFile({ audioPath, context, apiKey, signal, fetchImpl = fetch, pollIntervalMs = 3000 }) {
  if (!apiKey) throw new Error('未配置百炼 API 密钥');
  const auth = { Authorization: `Bearer ${apiKey}` };
  const request = async (url, options = {}) => {
    signal?.throwIfAborted();
    const response = await fetchImpl(url, { ...options, signal, redirect: 'error' });
    if (!response.ok) throw new Error('百炼转写请求失败');
    return response;
  };
  const json = async (url, options) => (await request(url, options)).json();
  const { data: policy } = await json(`${API}/uploads?action=getPolicy&model=${ASR_MODEL}`, { headers: auth });
  if (!policy?.upload_host || !policy.upload_dir || !policy.oss_access_key_id || !policy.signature || !policy.policy) throw new Error('上传授权数据不完整');
  const uploadHost = cloudUrl(policy.upload_host);
  const key = `${policy.upload_dir.replace(/\/$/, '')}/${randomUUID()}.m4a`;
  const form = new FormData();
  for (const [name, value] of Object.entries({
    OSSAccessKeyId: policy.oss_access_key_id, Signature: policy.signature, policy: policy.policy,
    key, success_action_status: '200', 'x-oss-object-acl': policy.x_oss_object_acl ?? 'private',
    'x-oss-forbid-overwrite': policy.x_oss_forbid_overwrite ?? 'true'
  })) form.append(name, value);
  form.append('file', await openAsBlob(audioPath, { type: 'audio/mp4' }), 'audio.m4a');
  await request(uploadHost, { method: 'POST', body: form });
  const submitted = await json(`${API}/services/audio/asr/transcription`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', 'X-DashScope-Async': 'enable', 'X-DashScope-OssResourceResolve': 'enable' },
    body: JSON.stringify({ model: ASR_MODEL, input: { file_urls: [`oss://${key}`] }, parameters: { channel_id: [0], diarization_enabled: true } })
  });
  const taskId = submitted.output?.task_id;
  if (!taskId) throw new Error('转写服务未返回任务 ID');
  while (true) {
    const { output } = await json(`${API}/tasks/${encodeURIComponent(taskId)}`, { headers: auth });
    if (output?.task_status === 'SUCCEEDED') {
      const result = output.results?.[0];
      if (result?.subtask_status === 'FAILED' || !result?.transcription_url) throw new Error('百炼音频转写失败');
      const raw = await json(cloudUrl(result.transcription_url));
      const cues = normalizeTranscript(raw);
      return { context, raw, cues, paragraphs: paragraphize(cues) };
    }
    if (!['PENDING', 'RUNNING'].includes(output?.task_status)) throw new Error('百炼转写任务失败');
    await wait(pollIntervalMs, undefined, { signal });
  }
}
