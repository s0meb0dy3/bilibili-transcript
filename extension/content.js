// 仅转发消息，不向视频页面注入界面。
(() => {
  const bridge = import(chrome.runtime.getURL('page-channel.js')).then(module => module.createBridge());
  const actions = new Set(['snapshot', 'identityMetadata', 'audioInfo', 'audioChunk', 'framesAt', 'cancelFramesAt', 'playback', 'seek']);
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || message?.channel !== 'bili-transcript-tab' || !actions.has(message.action)) return false;
    bridge.then(request => request(message.action, message.payload)).then(
      data => sendResponse({ ok: true, data }),
      error => sendResponse({ ok: false, error: error.message })
    );
    return true;
  });
})();
