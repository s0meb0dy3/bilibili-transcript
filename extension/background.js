const CONFIG_KEY = 'deepseekConfig';
const DEFAULT_MODEL = 'deepseek-flash';

async function setupSidebar() {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: 'settings', title: '设置', contexts: ['action'] });
}

const setup = () => setupSidebar().catch(() => console.error('[B站逐字稿] 侧栏初始化失败，请重新加载扩展'));
chrome.runtime.onInstalled.addListener(setup);
chrome.runtime.onStartup.addListener(setup);
chrome.contextMenus.onClicked.addListener(info => {
  if (info.menuItemId === 'settings') chrome.runtime.openOptionsPage();
});

async function handle(message) {
  if (message.action === 'openOptions') {
    await chrome.runtime.openOptionsPage();
    return null;
  }
  const values = await chrome.storage.local.get(CONFIG_KEY);
  const config = values[CONFIG_KEY] || {};
  const model = config.model || DEFAULT_MODEL;
  if (message.action === 'modelConfig') return { model, configured: Boolean(config.apiKey) };
  if (message.action !== 'complete') throw new Error('未知请求');
  if (!config.apiKey) throw new Error('请先在扩展设置中保存 DeepSeek API key');
  if (message.request?.model !== model) {
    const error = new Error('模型设置已变化，请重新启动智能分段');
    error.status = 409;
    throw error;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 55000);
  try {
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({ ...message.request, model }),
      signal: controller.signal
    });
    if (!response.ok) {
      const error = new Error(`DeepSeek 请求失败（HTTP ${response.status}），请检查配置或稍后重试`);
      error.status = response.status;
      throw error;
    }
    let body;
    try { body = await response.json(); }
    catch { throw new Error('DeepSeek 返回了无法解析的响应'); }
    if (body.choices?.[0]?.finish_reason !== 'stop') throw new Error('DeepSeek 未完整返回结果，请重试本批次');
    let result;
    try { result = JSON.parse(body.choices?.[0]?.message?.content); }
    catch { throw new Error('DeepSeek 返回的内容不是有效 JSON，请重试'); }
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('DeepSeek 返回的 JSON 格式不正确');
    return { response: result, usage: body.usage };
  } catch (error) {
    if (controller.signal.aborted) throw new Error('DeepSeek 请求超时（55 秒），可重试');
    if (error instanceof TypeError) throw new Error('无法连接 DeepSeek，请检查网络后重试');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (!['openOptions', 'modelConfig', 'complete'].includes(message?.action)) return false;
  handle(message).then(data => sendResponse({ ok: true, data }), error => sendResponse({ ok: false, error: error.message, status: error.status }));
  return true;
});
