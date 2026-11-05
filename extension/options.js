const form = document.getElementById('config');
const status = document.getElementById('status');
const providers = [
  { key: 'bailianConfig', input: 'bailian-key', model: 'bailian-model', fallback: 'qwen-audio-3.1-asr-flash-filetrans', clear: 'clear-bailian', name: '百炼' },
  { key: 'deepseekConfig', input: 'api-key', model: 'model', fallback: 'deepseek-flash', clear: 'clear', name: 'DeepSeek' }
];
async function show() {
  const values = await chrome.storage.local.get(providers.map(provider => provider.key));
  status.textContent = providers.map(provider => {
    document.getElementById(provider.model).value = values[provider.key]?.model || provider.fallback;
    return `${provider.name}：${values[provider.key]?.apiKey ? '密钥已保存' : '未配置'}`;
  }).join('；');
}
form.onsubmit = async event => {
  event.preventDefault();
  try {
    const values = await chrome.storage.local.get(providers.map(provider => provider.key));
    const next = {};
    for (const provider of providers) {
      const input = document.getElementById(provider.input);
      next[provider.key] = { model: document.getElementById(provider.model).value.trim() || provider.fallback, apiKey: input.value.trim() || values[provider.key]?.apiKey || '' };
      input.value = '';
    }
    await chrome.storage.local.set(next); await show();
  } catch { status.textContent = '保存失败，请重试'; }
};
for (const provider of providers) document.getElementById(provider.clear).onclick = async () => {
  await chrome.storage.local.set({ [provider.key]: { model: document.getElementById(provider.model).value || provider.fallback } });
  document.getElementById(provider.input).value = ''; await show();
};
show().catch(() => { status.textContent = '配置读取失败，请重新打开设置'; });
