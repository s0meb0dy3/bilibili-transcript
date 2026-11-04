// Runs in Bilibili's page world. Only this adapter reads page globals.
(() => {
  if (window.__biliTranscriptBridge) return;
  window.__biliTranscriptBridge = true;

  const playerURLs = new Map();
  new PerformanceObserver(list => {
    for (const entry of list.getEntries()) {
      if (!entry.name.startsWith('https://api.bilibili.com/x/player/')) continue;
      if (!/\/player\/(wbi\/)?v2\?/.test(entry.name)) continue;
      const cid = new URL(entry.name).searchParams.get('cid');
      if (cid) playerURLs.set(cid, entry.name);
    }
  }).observe({ type: 'resource', buffered: true });

  function context() {
    const bvid = location.pathname.match(/\/video\/(BV[\w]+)/)?.[1];
    if (!bvid) return null;
    const state = window.__INITIAL_STATE__;
    const video = state?.videoData;
    // Do not mix a newly navigated URL with the previous video's page state.
    if (video?.bvid !== bvid) return null;
    const part = Number(new URL(location.href).searchParams.get('p') || 1);
    const page = video.pages?.find(item => item.page === part);
    if (!page) return null;
    return {
      bvid, aid: String(video.aid), cid: String(page.cid), part,
      title: video.title, partTitle: page.part,
      key: `${bvid}:${page.cid}`
    };
  }

  function assertCurrent(expected) {
    const current = context();
    if (!current || current.key !== expected) throw new Error('视频已切换，请重新获取字幕');
    return current;
  }

  async function tracks(key) {
    const current = assertCurrent(key);
    // Reuse the player's signed URL rather than implementing Bilibili's WBI signing.
    const url = playerURLs.get(current.cid);
    if (!url) throw new Error('播放器尚未就绪，请稍后重试');
    const response = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`字幕信息获取失败（HTTP ${response.status}）`);
    const result = await response.json();
    assertCurrent(key);
    if (result.code !== 0) {
      if (result.code === -101) throw new Error('请先登录 B 站，再重试获取字幕');
      throw new Error(`字幕信息获取失败：${result.message || result.code}`);
    }
    if (!result.data?.subtitle) throw new Error('字幕信息解析失败，请刷新页面后重试');
    if (result.data.need_login_subtitle) throw new Error('请先登录 B 站，再重试获取字幕');
    return result.data.subtitle.subtitles
      .filter(track => /^(ai-)?zh(?:-|$)/i.test(track.lan))
      .map(track => ({
        id: track.id_str || String(track.id), language: track.lan,
        name: track.lan_doc, automatic: track.lan.startsWith('ai-'),
        url: new URL(track.subtitle_url, location.href).href
      }))
      .sort((a, b) => Number(b.language === 'ai-zh') - Number(a.language === 'ai-zh'));
  }

  async function subtitle(key, url) {
    assertCurrent(key);
    const address = new URL(url);
    if (address.protocol !== 'https:' || !['hdslb.com', 'bilibili.com'].some(domain => address.hostname.endsWith(`.${domain}`))) {
      throw new Error('字幕地址不属于 B 站');
    }
    const response = await fetch(address.href, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`字幕正文获取失败（HTTP ${response.status}），请刷新字幕后重试`);
    const data = await response.json();
    assertCurrent(key);
    return data;
  }

  window.addEventListener('message', async event => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (message?.channel !== 'bili-transcript-request') return;
    const { id, action, payload = {} } = message;
    try {
      let data;
      switch (action) {
        case 'context': data = context(); break;
        case 'snapshot': data = { context: context(), url: location.href }; break;
        case 'playback': {
          const current = assertCurrent(payload.key);
          const video = document.querySelector('.bpx-player-video-wrap video') || document.querySelector('video');
          data = video ? { key: current.key, timeMs: video.currentTime * 1000, paused: video.paused } : null;
          break;
        }
        case 'seek': {
          assertCurrent(payload.key);
          const video = document.querySelector('.bpx-player-video-wrap video') || document.querySelector('video');
          if (!video) throw new Error('播放器尚未就绪，请稍后重试');
          if (!Number.isFinite(payload.milliseconds) || payload.milliseconds < 0) throw new Error('无效的播放位置');
          video.currentTime = payload.milliseconds / 1000;
          let playBlocked = false;
          if (payload.play) {
            try { await video.play(); }
            catch { playBlocked = true; }
          }
          data = { playBlocked };
          break;
        }
        case 'tracks': data = await tracks(payload.key); break;
        case 'subtitle': data = await subtitle(payload.key, payload.url); break;
        default: return;
      }
      window.postMessage({ channel: 'bili-transcript-response', id, data }, location.origin);
    } catch (error) {
      window.postMessage({ channel: 'bili-transcript-response', id, error: error.message }, location.origin);
    }
  });
})();
