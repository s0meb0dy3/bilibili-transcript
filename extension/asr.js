const API = 'https://dashscope.aliyuncs.com/api/v1';
const AUDIO_HOSTS = ['hdslb.com', 'bilivideo.com', 'bilibili.com', 'bilivideo.cn'];
const MAX_BYTES = 2 * 1024 ** 3;
const TIMEOUT_MS = 30 * 60 * 1000;

function allowedUrl(value, hosts, httpsOnly = true) {
  let url;
  try { url = new URL(value); } catch { throw new Error('音频或云端资源地址无效'); }
  if ((httpsOnly ? url.protocol !== 'https:' : !['http:', 'https:'].includes(url.protocol)) ||
      url.username || url.password || (url.port && url.port !== '443' && !(url.protocol === 'http:' && url.port === '80')) ||
      !hosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
    throw new Error('音频或云端资源域名不在允许列表中');
  }
  return url.href;
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const aborted = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', aborted);
      resolve();
    }, ms);
    signal.addEventListener('abort', aborted, { once: true });
  });
}

/**
 * Run in the extension side panel. Store values are { task_id, raw? } or null.
 * Only task IDs and completed raw JSON are persisted; credentials and URLs are not.
 */
export async function transcribeAudio({
  audioUrl,
  loadAudio,
  config: { apiKey, model = 'qwen-audio-3.1-asr-flash-filetrans' },
  fetchImpl = fetch,
  signal,
  onProgress = () => {},
  store: { get, set },
  taskKey
}) {
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort(new DOMException('转写已取消', 'AbortError'));
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException('转写等待超时', 'TimeoutError'));
  }, TIMEOUT_MS);
  const activeSignal = controller.signal;
  let step = '准备转写';
  const progress = (stage, message) => onProgress({ stage, message });
  const request = async (url, options = {}) => {
    activeSignal.throwIfAborted();
    let response;
    try {
      response = await fetchImpl(url, {
        ...options, signal: activeSignal, redirect: 'error', credentials: 'omit'
      });
    } catch {
      activeSignal.throwIfAborted();
      throw new Error(`${step}：网络请求失败，请检查网络或扩展权限；已提交任务可续接`);
    }
    if (!response.ok) {
      const hint = response.status === 403
        ? (step === '下载B站音频' ? '音频CDN拒绝访问，可能是防盗链或音轨地址失效，不代表百炼密钥错误'
          : step === '上传OSS音频' ? 'OSS拒绝上传，请重新获取上传凭证后重试'
          : step === '获取转写结果' ? '结果地址访问被拒绝，可续接任务重试'
          : '百炼拒绝访问，请检查北京地域密钥、模型权限和账户状态')
        : '请稍后重试';
      throw new Error(`${step}失败（HTTP ${response.status}）：${hint}`);
    }
    return response;
  };
  const json = async (url, options) => {
    const response = await request(url, options);
    try { return await response.json(); }
    catch {
      activeSignal.throwIfAborted();
      throw new Error('转写服务返回的数据无法解析');
    }
  };
  const auth = { Authorization: `Bearer ${apiKey}` };
  try {
    activeSignal.throwIfAborted();
    const saved = await get(taskKey);
    if (saved?.raw !== undefined) {
      progress('completed', '已读取缓存转写结果');
      return saved.raw;
    }
    if (!apiKey) throw new Error('请先配置百炼 API Key');
    let taskId = saved?.task_id;
    if (!taskId) {
      if (Number(saved?.size) > MAX_BYTES) throw new Error('音频超过 2GB 上传限制');
      progress('downloading', '正在通过 B站页面下载原始音频');
      // Downloaded inside the Bilibili page so the CDN's hotlink Referer check passes.
      let audio;
      try {
        audio = loadAudio ? await loadAudio() : await request(allowedUrl(audioUrl, AUDIO_HOSTS, false)).then(r => r.blob());
      } catch (error) {
        if (activeSignal.aborted) throw error;
        throw new Error(`下载B站音频失败：${error.message}`);
      }
      if (audio.size > MAX_BYTES) throw new Error('音频超过 2GB 上传限制');
      progress('uploading', '正在上传原始音频，不进行转码');
      step = '获取百炼上传凭证';
      const { data: policy } = await json(`${API}/uploads?action=getPolicy&model=${encodeURIComponent(model)}`, { headers: auth });
      if (!policy?.upload_host || !policy.upload_dir || !policy.oss_access_key_id || !policy.signature || !policy.policy) {
        throw new Error('上传授权数据不完整');
      }
      const uploadHost = allowedUrl(policy.upload_host, ['aliyuncs.com']);
      const key = `${policy.upload_dir.replace(/\/$/, '')}/${crypto.randomUUID()}.m4a`;
      const form = new FormData();
      for (const [name, value] of Object.entries({
        OSSAccessKeyId: policy.oss_access_key_id,
        Signature: policy.signature,
        policy: policy.policy,
        key,
        success_action_status: '200',
        'x-oss-object-acl': policy.x_oss_object_acl ?? 'private',
        'x-oss-forbid-overwrite': policy.x_oss_forbid_overwrite ?? 'true'
      })) form.append(name, value);
      form.append('file', audio, 'audio.m4a');
      step = '上传OSS音频';
      await request(uploadHost, { method: 'POST', body: form });
      progress('submitting', '正在提交异步转写任务');
      step = '提交百炼转写任务';
      const submitted = await json(`${API}/services/audio/asr/transcription`, {
        method: 'POST',
        headers: {
          ...auth,
          'Content-Type': 'application/json',
          'X-DashScope-Async': 'enable',
          'X-DashScope-OssResourceResolve': 'enable'
        },
        body: JSON.stringify({
          model,
          input: { file_urls: [`oss://${key}`] },
          parameters: { channel_id: [0], diarization_enabled: true }
        })
      });
      taskId = submitted.output?.task_id;
      if (!taskId) throw new Error('转写服务未返回任务 ID');
      await set(taskKey, { task_id: taskId });
    }
    progress('polling', saved?.task_id ? '正在恢复已有转写任务' : '正在等待转写完成');
    while (true) {
      step = '查询百炼任务状态';
      const { output } = await json(`${API}/tasks/${encodeURIComponent(taskId)}`, { headers: auth });
      if (output?.task_status === 'FAILED' || output?.task_status === 'CANCELED') {
        await set(taskKey, null);
        throw new Error('百炼转写任务失败，重试将创建新任务');
      }
      if (output?.task_status === 'SUCCEEDED') {
        const result = output.results?.[0];
        if (result?.subtask_status === 'FAILED') {
          await set(taskKey, null);
          throw new Error('百炼音频转写失败，重试将创建新任务');
        }
        if (!result?.transcription_url) throw new Error('转写任务缺少结果地址');
        step = '获取转写结果';
        const raw = await json(allowedUrl(result.transcription_url, ['aliyuncs.com']));
        await set(taskKey, { task_id: taskId, raw });
        progress('completed', '转写完成');
        return raw;
      }
      if (!['PENDING', 'RUNNING'].includes(output?.task_status)) {
        throw new Error('转写任务状态异常，请重试恢复任务');
      }
      await wait(3000, activeSignal);
    }
  } catch (error) {
    if (timedOut) throw new Error('转写等待已超过 30 分钟，请稍后恢复已有任务');
    if (activeSignal.aborted) throw new DOMException('转写已取消，已提交的任务可继续恢复', 'AbortError');
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
  }
}
