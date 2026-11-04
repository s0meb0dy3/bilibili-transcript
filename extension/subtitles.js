export function createBridge() {
  const pending = new Map();
  let sequence = 0;
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (message?.channel !== 'bili-transcript-response') return;
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timeout);
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message.data);
  });
  return (action, payload = {}) => new Promise((resolve, reject) => {
    const id = `transcript-${Date.now()}-${++sequence}`;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error('页面响应超时，请刷新 B 站页面后重试'));
    }, 25000);
    pending.set(id, { resolve, reject, timeout });
    window.postMessage({ channel: 'bili-transcript-request', id, action, payload }, location.origin);
  });
}

export function normalizeSubtitles(raw) {
  if (!Array.isArray(raw?.body)) throw new Error('字幕格式无法解析，请刷新字幕后重试');
  return raw.body.map((item, index) => {
    if (typeof item.content !== 'string' || !Number.isFinite(item.from) || !Number.isFinite(item.to) || item.from < 0 || item.to < item.from) {
      throw new Error('字幕条目格式无法解析');
    }
    return {
      id: String(index + 1), text: item.content,
      startMs: Math.round(item.from * 1000), endMs: Math.round(item.to * 1000)
    };
  });
}

export function cacheKey(context, trackId) {
  return `transcript:${context.key}:${trackId}`;
}

export const preferenceKey = context => `preference:${context.key}`;

export async function readStored(key) {
  const values = await chrome.storage.local.get(key);
  return values[key];
}

export async function writeStored(key, value) {
  await chrome.storage.local.set({ [key]: value });
}
