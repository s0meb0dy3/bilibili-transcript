// 短模型请求统一走后台；业务模块只接收调用函数。
async function send(action, request, signal) {
  signal?.throwIfAborted();
  const result = await chrome.runtime.sendMessage({ action, request });
  signal?.throwIfAborted();
  if (!result?.ok) throw new Error(result?.error || '模型请求失败，请重试');
  return result.data;
}

export const getModelConfig = signal => send('modelConfig', undefined, signal);
export const completeText = (request, { signal } = {}) => send('complete', request, signal);
export const analyzeFrame = (request, { signal } = {}) => send('vision', request, signal);
