const configKey = 'deepseekConfig';
const form = document.getElementById('config');
const keyInput = document.getElementById('api-key');
const modelInput = document.getElementById('model');
const status = document.getElementById('status');

async function showConfig() {
  const values = await chrome.storage.local.get(configKey);
  const config = values[configKey] || {};
  modelInput.value = config.model || 'deepseek-flash';
  status.textContent = config.apiKey ? 'API key 已保存；不会回显。' : '尚未配置 API key。';
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const values = await chrome.storage.local.get(configKey);
    const previous = values[configKey] || {};
    await chrome.storage.local.set({ [configKey]: {
      model: modelInput.value.trim() || 'deepseek-flash',
      apiKey: keyInput.value.trim() || previous.apiKey || ''
    } });
    keyInput.value = '';
    await showConfig();
  } catch { status.textContent = '保存失败，请重试。'; }
});

document.getElementById('clear').addEventListener('click', async () => {
  try {
    await chrome.storage.local.set({ [configKey]: { model: modelInput.value.trim() || 'deepseek-flash' } });
    keyInput.value = '';
    await showConfig();
  } catch { status.textContent = '清除失败，请重试。'; }
});

showConfig().catch(() => { status.textContent = '读取配置失败，请重新打开设置。'; });
