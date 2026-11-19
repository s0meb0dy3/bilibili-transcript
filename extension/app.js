import { readStored, writeStored } from './storage.js';
import { createTabBridge } from './tabs.js';
import { TranscriptPanel, activeCueAt } from './panel.js';
import { loadPageAudio } from './audio-loader.js';
import { createFaceCapture, cropFaceImage } from './face-capture.js';
import { createAgentView } from './agent-view.js';

const request = createTabBridge();
let context = null;
let documentData = null;
let revision = 0;
let task = null;
let route = '';
let checking = false;
let syncAgain = false;
let checkingPlayback = false;
let windowId;
let tabId;
const resultKey = ctx => `asr-document:v1:${ctx.key}`;
const avatarKey = ctx => `asr-avatars:v1:${ctx.key}`;

function cancel(message = '') {
  task?.abort();
  task = null;
  panel.setTaskState({ message });
}

function clear() {
  agentView.cancel();
  cancel();
  revision++;
  documentData = null;
  panel.clear();
}

function present(data) {
  documentData = data;
  panel.renderDocument(data);
  if (data.agentResult?.summary) panel.setSummary(data.agentResult.summary);
  panel.setStatus(data.cues.length ? '' : '模型未识别到有效语音，可重新转写', { retry: !data.cues.length });
  updatePlayback();
}

async function load() {
  if (!context || task) return;
  const token = revision;
  const original = documentData;
  const target = context;
  panel.setStatus('正在读取本地转写…');
  try {
    const cached = await readStored(resultKey(target));
    if (token !== revision || task || documentData !== original) return;
    if (cached) {
      const avatars = await readStored(avatarKey(target));
      if (token !== revision || task || documentData !== original) return;
      present({ ...cached, context: target, avatars: avatars || {} });
    }
    else panel.setStatus('');
  } catch {
    if (token === revision) panel.setStatus('本地结果读取失败，请重试', { error: true, retry: true });
  }
}

const panel = new TranscriptPanel(chrome.runtime.getURL('panel.css'), {
  refresh: () => context ? load() : syncContext(),
  analyze: async () => {
    if (!context || task) return;
    const target = context;
    const active = task = new AbortController();
    panel.setTaskState({ busy: true, message: '正在准备…' });
    let error;
    try {
      const metadata = await request('identityMetadata', { tabId: target.tabId, key: target.key }).catch(() => null);
      if (active.signal.aborted) return;
      context = { ...target, ...metadata };
      const inspectFaces = await readStored('speakerAvatars').catch(() => false);
      if (!active.signal.aborted) await agentView.analyze({ inspectFaces: inspectFaces === true });
    } catch (failure) { error = failure; }
    finally {
      if (task === active) {
        task = null;
        panel.setTaskState({ message: error?.message, error: Boolean(error) });
      }
    }
  },
  cancelTask: () => { agentView.cancel(); cancel(); },
  seek: async (milliseconds, { play = false } = {}) => {
    if (!context) return;
    const token = revision;
    try {
      const result = await request('seek', { tabId: context.tabId, key: context.key, milliseconds, play });
      if (token !== revision) return;
      if (result.playBlocked) panel.setStatus('已跳转，请点击左侧播放器继续播放');
      updatePlayback();
    } catch (error) { if (token === revision) panel.setStatus(error.message, { error: true }); }
  },
  follow: follow => writeStored('settings', { follow }).catch(() => {})
});
const agentView = createAgentView({
  getDocument: () => documentData ? { ...documentData, context } : { context },
  loadAudio: (target, signal) => loadPageAudio({ request, context: target, signal }),
  captureFaces: (target, times, signal) => createFaceCapture({
    captureFrames: (times, signal) => request('framesAt', { tabId: target.tabId, key: target.key, times }, signal)
  })(times, signal),
  cropFace: (...args) => cropFaceImage(...args),
  onProgress: message => panel.setTaskState({ busy: true, message }),
  onResult: async (result, original, signal, avatars = {}) => {
    const people = Object.fromEntries(Object.entries(result.speakers).map(([id, name]) => [id, { id, name, inferred: true }]));
    const updated = { ...original, people, agentResult: result, avatars };
    await writeStored(resultKey(original.context), updated);
    await writeStored(avatarKey(original.context), avatars);
    if (task && !signal?.aborted) present(updated);
  }
});
readStored('settings').then(settings => { if (settings) panel.setFollow(settings.follow, false); }).catch(() => {});

async function updatePlayback() {
  if (!documentData || !context || checkingPlayback) return;
  const token = revision;
  checkingPlayback = true;
  try {
    const state = await request('playback', { tabId: context.tabId, key: context.key });
    if (token === revision) panel.setActive(state ? activeCueAt(documentData.cues, state.timeMs) : null);
  } catch { if (token === revision) panel.setActive(null); }
  finally { checkingPlayback = false; }
}

async function syncContext() {
  if (checking) { syncAgain = true; return; }
  checking = true;
  const token = revision;
  try {
    const snapshot = await request('snapshot');
    if (token !== revision) return;
    windowId = snapshot.windowId; tabId = snapshot.tabId;
    const nextRoute = `${snapshot.tabId}:${snapshot.context?.key || snapshot.url}`;
    panel.setAvailable(snapshot.available);
    if (route !== nextRoute) { route = nextRoute; context = null; clear(); }
    if (!snapshot.available) { panel.setStatus('请在左侧打开 B站视频'); return; }
    if (!snapshot.context) { panel.setStatus('等待播放器就绪，请刷新视频页或重试', { retry: true }); return; }
    if (!context) {
      context = { ...snapshot.context, tabId: snapshot.tabId };
      panel.setContext(context); load();
    }
  } catch (error) { if (token === revision) panel.setStatus(error.message, { error: true, retry: true }); }
  finally { checking = false; if (syncAgain) { syncAgain = false; syncContext(); } }
}
function invalidate() { context = null; route = ''; clear(); syncContext(); }
chrome.tabs.onActivated.addListener(info => { if (windowId === undefined || info.windowId === windowId) invalidate(); });
chrome.tabs.onUpdated.addListener((id, change) => { if (id === tabId && (change.url || change.status === 'loading')) invalidate(); });
chrome.tabs.onRemoved.addListener(id => { if (id === tabId) invalidate(); });
syncContext();
setInterval(syncContext, 1000);
setInterval(updatePlayback, 250);
