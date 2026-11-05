// The side panel talks to the active Bilibili tab; it never reads the page DOM.
export function createTabBridge(tabs = chrome.tabs) {
  async function send(tabId, action, payload) {
    let result;
    try {
      result = await tabs.sendMessage(tabId, { channel: 'bili-transcript-tab', action, payload });
    } catch (error) {
      if (/Receiving end does not exist|Could not establish connection/.test(error?.message || '')) {
        throw new Error('视频页脚本未就绪。请刷新左侧 B 站视频页（或重新加载扩展后刷新）再试');
      }
      throw new Error('无法连接视频页，请刷新左侧 B 站页面后重试');
    }
    if (!result?.ok) throw new Error(result?.error || '视频页没有响应，请刷新页面后重试');
    return result.data;
  }

  return async (action, payload = {}) => {
    if (action === 'snapshot') {
      const [tab] = await tabs.query({ active: true, currentWindow: true });
      const available = /^https:\/\/www\.bilibili\.com\/video\/BV\w+/.test(tab?.url || '');
      const target = { tabId: tab?.id, windowId: tab?.windowId, url: tab?.url || '', available };
      if (!available) return { ...target, context: null };
      const snapshot = await send(tab.id, action, {});
      return { ...snapshot, ...target, url: snapshot.url || target.url };
    }
    if (action === 'seek') {
      const [active] = await tabs.query({ active: true, currentWindow: true });
      if (active?.id !== payload.tabId) throw new Error('当前标签页已切换，请重试');
    }
    return send(payload.tabId, action, payload);
  };
}
