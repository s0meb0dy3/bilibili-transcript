import { normalizeSubtitles, cacheKey, preferenceKey, readStored, writeStored } from './subtitles.js';
import { createTabBridge } from './tabs.js';
import { segmentCues, SEGMENTATION_VERSION } from './segmentation.js';
import { TranscriptPanel, activeCueAt, toMarkdown } from './panel.js';
import { runSemanticSegmentation, semanticToDisplay } from './semantic.js';

const request = createTabBridge();
let context = null;
let documentData = null;
let tracks = [];
let selectedTrackId = null;
let revision = 0;
let loading = false;
let lastRoute = '';
let checkingContext = false;
let semanticTask = null;
let checkingPlayback = false;
let syncAgain = false;
let currentWindowId;
let activeTabId;

function modelMessage(action, payload = {}, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('已取消', 'AbortError'));
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    chrome.runtime.sendMessage({ action, ...payload }).then(result => {
      if (signal?.aborted) return;
      if (!result?.ok) {
        const error = new Error(result?.error || '扩展后台未响应，请重新加载扩展');
        error.status = result?.status;
        reject(error);
      } else resolve(result.data);
    }, () => reject(new Error('扩展后台连接失败，请重新加载扩展'))).finally(() => {
      signal?.removeEventListener('abort', abort);
    });
  });
}

function stopSemantic(message = '') {
  semanticTask?.controller.abort();
  semanticTask = null;
  panel.setSemanticState?.({ message });
}

async function startSemantic() {
  if (!documentData || loading || semanticTask) return;
  const original = documentData;
  const token = revision;
  const controller = new AbortController();
  const task = { controller };
  semanticTask = task;
  const current = () => semanticTask === task && !controller.signal.aborted && revision === token && documentData === original;
  panel.setSemanticState?.({ busy: true, message: '正在准备智能分段…基础稿仍可阅读。' });
  try {
    const config = await modelMessage('modelConfig', {}, controller.signal);
    if (!current()) return;
    if (!config.configured) {
      throw new Error('请右键浏览器工具栏的插件图标，选择“设置”并保存 API key，再重试智能分段。');
    }
    const key = cacheKey(original.context, original.track.id);
    const prefix = `${key}:semantic:${original.savedAt}:`;
    const result = await runSemanticSegmentation({
      raw: original.raw,
      model: config.model,
      signal: controller.signal,
      callModel: (request, { signal } = {}) => modelMessage('complete', { request }, signal || controller.signal),
      store: {
        get: checkpoint => readStored(prefix + checkpoint),
        set: (checkpoint, value) => current() ? writeStored(prefix + checkpoint, value) : Promise.resolve()
      },
      onProgress: ({ completed, total }) => {
        if (current()) panel.setSemanticState?.({ busy: true, message: `智能分段 ${completed}/${total}，当前正文仍可阅读。` });
      }
    });
    if (!current()) return;
    const paragraphs = semanticToDisplay(result);
    const data = { ...original, semantic: result, paragraphs };
    // Persist while this document still owns the task; navigation cannot render it.
    await writeStored(key, {
      raw: original.raw, paragraphs: segmentCues(original.cues, { targetChars: 200 }),
      algorithmVersion: SEGMENTATION_VERSION, savedAt: original.savedAt, semantic: result
    });
    if (!current()) return;
    present(data);
    panel.setSemanticState?.({ message: '智能分段完成，已校验字幕内容并保存至本地。' });
  } catch (error) {
    if (!current()) return;
    panel.setSemanticState?.({ error: true, message: `智能分段失败：${error.message} 当前正文已保留，可重试。` });
  } finally {
    if (semanticTask === task) semanticTask = null;
  }
}

const panel = new TranscriptPanel(chrome.runtime.getURL('panel.css'), {
  refresh: () => {
    if (context) load({ refresh: true, trackId: selectedTrackId });
    else syncContext();
  },
  track: trackId => load({ trackId }),
  semantic: () => startSemantic(),
  cancelSemantic: () => stopSemantic('已取消智能分段，当前正文已保留。'),
  seek: async (milliseconds, { play = false } = {}) => {
    if (!context) return;
    const target = context;
    const token = revision;
    try {
      const result = await request('seek', { tabId: target.tabId, key: target.key, milliseconds, play });
      if (token !== revision) return;
      if (result.playBlocked) panel.setStatus('已跳转到对应字幕，浏览器未允许自动播放，请点击左侧播放器继续');
      updatePlayback();
    } catch (error) {
      if (token === revision) panel.setStatus(error.message, { error: true, retry: true });
    }
  },
  follow: follow => {
    writeStored('settings', { follow }).catch(() => panel.setStatus('跟随设置保存失败，当前页面仍可使用'));
  },
  export: () => {
    if (!documentData) return;
    const blob = new Blob([toMarkdown(documentData)], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${documentData.context.bvid}-P${documentData.context.part}-${documentData.track.language}.md`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
});

readStored('settings').then(settings => {
  if (settings) panel.setFollow(settings.follow, false);
}).catch(() => {});

async function updatePlayback() {
  if (!documentData || !context || checkingPlayback) return;
  const target = context;
  const token = revision;
  checkingPlayback = true;
  try {
    const state = await request('playback', { tabId: target.tabId, key: target.key });
    if (token === revision) panel.setActive(state ? activeCueAt(documentData.cues, state.timeMs) : null);
  } catch {
    // Navigation is reconciled by syncContext; never highlight a stale tab.
    if (token === revision) panel.setActive(null);
  } finally {
    checkingPlayback = false;
  }
}

function reset() {
  stopSemantic();
  revision++;
  loading = false;
  documentData = null;
  tracks = [];
  selectedTrackId = null;
  panel.clear();
}

async function syncContext() {
  if (checkingContext) { syncAgain = true; return; }
  checkingContext = true;
  const token = revision;
  try {
    const snapshot = await request('snapshot');
    if (token !== revision) return;
    currentWindowId = snapshot.windowId;
    activeTabId = snapshot.tabId;
    const route = `${snapshot.tabId}:${snapshot.context?.key || snapshot.url}`;
    panel.setAvailable(snapshot.available);
    if (route !== lastRoute) {
      lastRoute = route;
      context = null;
      reset();
    }
    if (!snapshot.available) {
      panel.setStatus('请在左侧打开一个 B 站视频，逐字稿会自动加载');
      return;
    }
    const next = snapshot.context;
    if (next && (next.key !== context?.key || snapshot.tabId !== context?.tabId)) {
      context = { ...next, tabId: snapshot.tabId };
      reset();
      panel.setContext(context);
      load();
    } else if (!next) {
      panel.setStatus('正在等待左侧播放器就绪；若长时间无响应，请刷新 B 站页面', { retry: true });
    }
  } catch (error) {
    if (token === revision) panel.setStatus(error.message, { error: true, retry: true });
  } finally {
    checkingContext = false;
    if (syncAgain) { syncAgain = false; syncContext(); }
  }
}

function invalidateTab() {
  context = null;
  lastRoute = '';
  reset();
  panel.setStatus('正在识别当前标签页…');
  syncContext();
}

function makeDocument(raw, track, savedAt, currentContext, semantic) {
  const cues = normalizeSubtitles(raw);
  return {
    context: currentContext, track, raw, cues,
    paragraphs: semantic ? semanticToDisplay(semantic) : segmentCues(cues, { targetChars: 200 }),
    algorithmVersion: SEGMENTATION_VERSION, savedAt, ...(semantic ? { semantic } : {})
  };
}

function present(data, cached = false) {
  documentData = data;
  panel.renderDocument(data);
  const oversized = data.paragraphs.some(paragraph => [...paragraph.text].length > 600);
  const messages = [];
  if (cached) messages.push('已读取本地缓存，可点击刷新获取最新字幕。');
  if (oversized) messages.push('部分字幕缺少可靠句末边界或句子较长；为避免截断句子，保留长段。播放时会高亮当前字幕。');
  if (!data.cues.length) messages.push('当前中文轨道没有字幕正文，请刷新重试。');
  panel.setStatus(messages.join(' '), { retry: !data.cues.length });
  updatePlayback();
}

async function load({ refresh = false, trackId } = {}) {
  if (!context) return;
  stopSemantic();
  const currentContext = context;
  if (trackId) selectedTrackId = trackId;
  const token = ++revision;
  const current = () => token === revision && context?.key === currentContext.key && context?.tabId === currentContext.tabId;
  loading = true;
  const keepDocument = documentData?.context.key === currentContext.key
    && (!trackId || trackId === documentData.track.id);
  if (!keepDocument) {
    documentData = null;
    panel.clear();
  }
  panel.setStatus('正在获取字幕…');
  try {
    const preference = await readStored(preferenceKey(currentContext));
    if (!current()) return;
    const preferredId = selectedTrackId || preference?.trackId;
    if (refresh && preferredId) {
      const key = cacheKey(currentContext, preferredId);
      const cached = await readStored(key);
      if (!current()) return;
      if (documentData?.semantic && documentData.track.id === preferredId) {
        const basic = makeDocument(documentData.raw, documentData.track, Date.now(), currentContext);
        present(basic);
        panel.setStatus('正在刷新字幕，已恢复基础稿…');
      }
      if (cached?.semantic) {
        const { semantic: _semantic, ...basic } = cached;
        await writeStored(key, { ...basic, savedAt: Date.now() });
        if (!current()) return;
      }
    }
    // Restore a document without requiring the network or a still-valid signed URL.
    if (!refresh && preference?.tracks?.length) {
      const chosen = preference.tracks.find(track => track.id === preferredId) || preference.tracks[0];
      const cached = await readStored(cacheKey(currentContext, chosen.id));
      if (!current()) return;
      if (cached) {
        selectedTrackId = chosen.id;
        tracks = preference.tracks;
        panel.setTracks(tracks, chosen.id);
        present(makeDocument(cached.raw, chosen, cached.savedAt, currentContext, cached.semantic), true);
        await writeStored(preferenceKey(currentContext), { trackId: chosen.id, tracks });
        return;
      }
    }
    const available = await request('tracks', { tabId: currentContext.tabId, key: currentContext.key });
    if (!current()) return;
    tracks = available;
    if (!tracks.length) {
      documentData = null;
      panel.clear();
      panel.setStatus('当前视频没有可获取的中文字幕', { retry: true });
      return;
    }
    const track = tracks.find(item => item.id === preferredId) || tracks[0];
    selectedTrackId = track.id;
    panel.setTracks(tracks, track.id);
    const raw = await request('subtitle', { tabId: currentContext.tabId, key: currentContext.key, url: track.url });
    if (!current()) return;
    // Do not persist expiring subtitle URLs; cache the original body instead.
    const { url: _url, ...descriptor } = track;
    const savedAt = Date.now();
    const data = makeDocument(raw, descriptor, savedAt, currentContext);
    present(data);
    try {
      await writeStored(cacheKey(currentContext, track.id), {
        raw, paragraphs: data.paragraphs, algorithmVersion: SEGMENTATION_VERSION, savedAt
      });
      if (!current()) return;
      await writeStored(preferenceKey(currentContext), {
        trackId: track.id,
        tracks: tracks.map(({ url, ...item }) => item)
      });
    } catch (error) {
      if (current()) panel.setStatus(`字幕可正常阅读，但本地保存失败：${error.message}`, { error: true });
    }
  } catch (error) {
    if (current()) panel.setStatus(error.message, { error: true, retry: true });
  } finally {
    if (current()) loading = false;
  }
}

chrome.tabs.onActivated.addListener(info => {
  if (currentWindowId === undefined || info.windowId === currentWindowId) invalidateTab();
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (tabId === activeTabId && (change.url || change.status === 'loading')) invalidateTab();
});
chrome.tabs.onRemoved.addListener(tabId => {
  if (tabId === activeTabId) invalidateTab();
});
syncContext();
setInterval(syncContext, 1000);
setInterval(updatePlayback, 250);
