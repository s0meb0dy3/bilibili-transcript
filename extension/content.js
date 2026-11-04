// Relay only. No transcript UI or layout changes are injected into Bilibili.
(() => {
  const bridge = import(chrome.runtime.getURL('subtitles.js')).then(module => module.createBridge());
  const actions = new Set(['snapshot', 'tracks', 'subtitle', 'playback', 'seek']);
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || message?.channel !== 'bili-transcript-tab' || !actions.has(message.action)) return false;
    bridge.then(request => request(message.action, message.payload)).then(
      data => sendResponse({ ok: true, data }),
      error => sendResponse({ ok: false, error: error.message })
    );
    return true;
  });
})();
