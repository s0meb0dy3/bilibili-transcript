const BASE_URL = 'http://127.0.0.1:43127';

// 自动向本机服务建立扩展连接，provider 密钥始终留在服务端。
export function createAgentClient({ token, fetchImpl = fetch } = {}) {
  let activeToken = token;
  async function ensureToken(signal) {
    if (activeToken) return activeToken;
    let response;
    try { response = await fetchImpl(`${BASE_URL}/connection`, { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: '{}' }); }
    catch { throw new Error('本地 Agent 未启动，请先执行 npm run agent:dev'); }
    if (!response.ok) throw new Error('本地 Agent 未启动，或连接配置无效');
    activeToken = (await response.json()).token;
    if (!activeToken) throw new Error('本地 Agent 未返回连接凭据');
    return activeToken;
  }
  async function request(path, { method = 'GET', body, signal } = {}) {
    const auth = await ensureToken(signal);
    const response = await fetchImpl(`${BASE_URL}${path}`, {
      method, signal,
      headers: { Authorization: `Bearer ${auth}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    if (!response.ok) throw new Error(`本地 Agent 请求失败（HTTP ${response.status}）`);
    return response;
  }
  return {
    start: async (document, { prompt, mode = 'analyze', signal, inspectFaces } = {}) =>
      (await request('/tasks', { method: 'POST', body: { document, prompt, mode, inspectFaces }, signal })).json(),
    startContext: async (context, { prompt, mode = 'analyze', signal, inspectFaces } = {}) =>
      (await request('/tasks', { method: 'POST', body: { context, prompt, mode, inspectFaces }, signal })).json(),
    submitFaces: async (id, requestId, frames, signal) =>
      (await request(`/tasks/${encodeURIComponent(id)}/faces`, { method: 'POST', body: { requestId, frames }, signal })).json(),
    uploadAudio: async (id, audio, signal) => {
      const auth = await ensureToken(signal);
      const response = await fetchImpl(`${BASE_URL}/tasks/${encodeURIComponent(id)}/audio`, {
        method: 'POST', signal, body: audio,
        headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'audio/mp4' }
      });
      if (!response.ok) throw new Error(`本地 Agent 音频上传失败（HTTP ${response.status}）`);
      return response.json();
    },
    get: async (id, signal) => (await request(`/tasks/${encodeURIComponent(id)}`, { signal })).json(),
    cancel: async id => (await request(`/tasks/${encodeURIComponent(id)}/cancel`, { method: 'POST' })).json(),
    async watch(id, onEvent, signal) {
      const response = await request(`/tasks/${encodeURIComponent(id)}/events`, { signal });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (true) {
          const { value, done } = await reader.read();
          buffer += decoder.decode(value || new Uint8Array(), { stream: !done }).replace(/\r\n/g, '\n');
          let end;
          while ((end = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            if (data) await onEvent(JSON.parse(data));
          }
          if (done) break;
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
  };
}
