// 内容脚本与页面主环境之间的消息通道。
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
    }, action === 'audioInfo' || action === 'framesAt' ? 180000 : 25000);
    pending.set(id, { resolve, reject, timeout });
    window.postMessage({ channel: 'bili-transcript-request', id, action, payload }, location.origin);
  });
}
