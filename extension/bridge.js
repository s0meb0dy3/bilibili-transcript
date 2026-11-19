// 运行在页面主环境，集中读取 B站数据和播放器。
(() => {
  if (window.__biliTranscriptBridge) return;
  window.__biliTranscriptBridge = true;

  // 音频留在页面内，由侧栏按片读取。
  let audioCache = null;
  let frameCapture = null;

  function seekFrame(video, seconds, signal) {
    if (!video.seeking && Math.abs(video.currentTime - seconds) <= 0.01) return;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        video.removeEventListener('seeked', done);
        signal.removeEventListener('abort', aborted);
      };
      const done = () => { cleanup(); resolve(); };
      const aborted = () => { cleanup(); reject(signal.reason); };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('视频画面定位超时，请稍后重试'));
      }, 10000);
      signal.addEventListener('abort', aborted, { once: true });
      video.addEventListener('seeked', done, { once: true });
      video.currentTime = seconds;
    });
  }

  function context() {
    const bvid = location.pathname.match(/\/video\/(BV[\w]+)/)?.[1];
    if (!bvid) return null;
    const state = window.__INITIAL_STATE__;
    const video = state?.videoData;
    // 页面切换时，等待地址与视频数据一致。
    if (video?.bvid !== bvid) return null;
    const part = Number(new URL(location.href).searchParams.get('p') || 1);
    const page = video.pages?.find(item => item.page === part);
    if (!page) return null;
    return {
      bvid, aid: String(video.aid), cid: String(page.cid), part,
      title: video.title, partTitle: page.part,
      description: video.desc || '', owner: video.owner?.name || '',
      uploader: { name: video.owner?.name || '' },
      chapters: (video.pages || []).map(item => item.part),
      key: `${bvid}:${page.cid}`
    };
  }

  function assertCurrent(expected) {
    const current = context();
    if (!current || current.key !== expected) throw new Error('视频已切换，请重新转写');
    return current;
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
        case 'cancelFramesAt': {
          if (frameCapture?.id === payload.captureId) frameCapture.controller.abort();
          break;
        }
        case 'framesAt': {
          assertCurrent(payload.key);
          const video = document.querySelector('.bpx-player-video-wrap video') || document.querySelector('video');
          if (!video?.videoWidth || !Number.isFinite(video.duration)) throw new Error('播放器尚未就绪，请稍后重试');
          if (frameCapture) throw new Error('播放器正在截取画面，请稍后重试');
          const times = (payload.times || []).filter(value => Number.isFinite(value) && value >= 0).slice(0, 40);
          const resume = { time: video.currentTime, paused: video.paused };
          const controller = new AbortController();
          const { signal } = controller;
          const canvas = document.createElement('canvas');
          const drawing = canvas.getContext('2d');
          const frames = [];
          frameCapture = { id: payload.captureId, controller };
          try {
            video.pause();
            for (const timeMs of times) {
              signal.throwIfAborted();
              assertCurrent(payload.key);
              const seconds = Math.min(timeMs / 1000, Math.max(0, video.duration - 0.05));
              await seekFrame(video, seconds, signal);
              signal.throwIfAborted();
              assertCurrent(payload.key);
              const actualTimeMs = Math.round(video.currentTime * 1000);
              if (Math.abs(actualTimeMs - timeMs) > 500) continue;
              canvas.width = Math.min(video.videoWidth, 1280);
              canvas.height = Math.round(video.videoHeight * canvas.width / video.videoWidth);
              let dataUrl;
              do {
                drawing.drawImage(video, 0, 0, canvas.width, canvas.height);
                dataUrl = canvas.toDataURL('image/jpeg', 0.82);
                if (dataUrl.length <= 280_000) break;
                canvas.width = Math.max(1, Math.floor(canvas.width * 0.75));
                canvas.height = Math.max(1, Math.floor(canvas.height * 0.75));
              } while (true);
              frames.push({ timeMs: actualTimeMs, dataUrl });
            }
          } finally {
            frameCapture = null;
            if (context()?.key === payload.key) {
              video.currentTime = resume.time;
              if (!resume.paused) video.play().catch(() => {});
            }
          }
          data = frames;
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
        case 'audioInfo': {
          const current = assertCurrent(payload.key);
          const api = new URL('https://api.bilibili.com/x/player/playurl');
          api.search = new URLSearchParams({ bvid: current.bvid, cid: current.cid, fnval: '4048', fnver: '0', qn: '80', fourk: '1' });
          const info = await fetch(api, { credentials: 'include', signal: AbortSignal.timeout(20000) });
          if (!info.ok) throw new Error(`音轨地址获取失败（HTTP ${info.status}）`);
          const playurl = await info.json();
          if (playurl.code !== 0) throw new Error(`音轨地址获取失败：${playurl.message || playurl.code}`);
          const audio = playurl.data?.dash?.audio?.filter(item => /mp4a/.test(item.codecs)).sort((a, b) => b.bandwidth - a.bandwidth)[0];
          if (!audio) throw new Error('当前视频没有可访问的 AAC 音轨');
          // 页面请求自带来源，避免 CDN 防盗链拒绝。
          const media = await fetch(audio.baseUrl || audio.base_url, { signal: AbortSignal.timeout(120000) });
          if (!media.ok) throw new Error(`音频下载被服务器拒绝（HTTP ${media.status}）`);
          audioCache = { key: current.key, type: media.headers.get('content-type') || 'audio/mp4', bytes: new Uint8Array(await media.arrayBuffer()) };
          assertCurrent(payload.key);
          data = { type: audioCache.type, size: audioCache.bytes.length };
          break;
        }
        case 'audioChunk': {
          const current = assertCurrent(payload.key);
          if (!audioCache || audioCache.key !== current.key) throw new Error('音频缓存已失效，请重新开始转写');
          const size = Math.max(1, Math.min(Number(payload.size) || 4 * 1024 * 1024, 8 * 1024 * 1024));
          const offset = Number(payload.offset) || 0;
          const slice = audioCache.bytes.subarray(offset, offset + size);
          let binary = '';
          for (let i = 0; i < slice.length; i += 0x8000) binary += String.fromCharCode(...slice.subarray(i, i + 0x8000));
          data = { offset, base64: btoa(binary), done: offset + slice.length >= audioCache.bytes.length };
          if (data.done) audioCache = null;
          break;
        }
        case 'identityMetadata': {
          const current = assertCurrent(payload.key);
          const mid = window.__INITIAL_STATE__.videoData.owner?.mid;
          if (!mid) { data = current; break; }
          const response = await fetch(`https://api.bilibili.com/x/web-interface/card?mid=${encodeURIComponent(mid)}`, {
            credentials: 'omit', signal: AbortSignal.timeout(15000)
          });
          if (!response.ok) throw new Error('UP主公开资料获取失败，请稍后重试');
          const result = await response.json();
          assertCurrent(payload.key);
          if (result.code !== 0 || !result.data?.card) throw new Error('UP主公开资料暂不可用，请稍后重试');
          const card = result.data.card;
          data = { ...current, uploader: {
            name: card.name || current.uploader.name,
            bio: card.sign || '',
            verification: card.Official?.title || card.official?.title || card.official_verify?.desc || ''
          } };
          break;
        }
        default: return;
      }
      window.postMessage({ channel: 'bili-transcript-response', id, data }, location.origin);
    } catch (error) {
      window.postMessage({ channel: 'bili-transcript-response', id, error: error.message }, location.origin);
    }
  });
})();
