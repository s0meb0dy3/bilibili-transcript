import { readStored, writeStored } from './storage.js';
import { createTabBridge } from './tabs.js';
import { TranscriptPanel, activeCueAt } from './panel.js';
import { loadPageAudio } from './audio-loader.js';
import { createFaceCapture, cropFaceImage } from './face-capture.js';
import { createAgentClient } from './agent-client.js';
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
let readingTimer;
let savedReading;
let translations;
let translationJob;
const resultKey = ctx => `asr-document:v1:${ctx.key}`;
const avatarKey = ctx => `asr-avatars:v1:${ctx.key}`;
const panelStateKey = ctx => `asr-panel-state:v1:${ctx.key}`;
const translationKey = ctx => `asr-translation:zh-CN:v1:${ctx.key}`;

function saveReading() {
  clearTimeout(readingTimer);
  if (!documentData) return;
  const state = panel.getState();
  const serialized = JSON.stringify(state);
  if (serialized === savedReading) return;
  savedReading = serialized;
  void writeStored(panelStateKey(documentData.context), state).catch(() => {});
}

function cancel(message = '') {
  task?.abort();
  task = null;
  panel.setTaskState({ message });
}

function clear() {
  saveReading();
  translationJob?.abort();
  translationJob = undefined;
  translations = undefined;
  savedReading = undefined;
  agentView.cancel();
  cancel();
  revision++;
  documentData = null;
  panel.clear();
}

function present(data, state = { view: data.agentResult?.summary ? 'summary' : 'transcript' }) {
  documentData = data;
  panel.renderDocument(data, { translations, bilingual: state.bilingual });
  panel.setSummary(data.agentResult?.summary);
  panel.setTranslationStatus(Boolean(translationJob));
  panel.setStatus(data.cues.length ? '' : '模型未识别到有效语音，可重新转写', { retry: !data.cues.length });
  panel.restoreState(state);
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
      const [avatars, state, translated] = await Promise.all([
        readStored(avatarKey(target)), readStored(panelStateKey(target)), readStored(translationKey(target))
      ]);
      if (token !== revision || task || documentData !== original) return;
      translations = translated?.savedAt === cached.savedAt ? translated?.translations : undefined;
      savedReading = JSON.stringify(state);
      present({ ...cached, context: target, avatars: avatars || {} }, state && { ...state, manualReading: true });
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
  follow: follow => writeStored('settings', { follow }).catch(() => {}),
  state: saveReading,
  scroll: () => { clearTimeout(readingTimer); readingTimer = setTimeout(saveReading, 250); },
  translate: async () => {
    if (!documentData?.cues.length || translationJob) return;
    if (translations) {
      present(documentData, { ...panel.getState(), bilingual: !panel.bilingual });
      saveReading();
      return;
    }
    const target = documentData;
    const job = translationJob = new AbortController();
    panel.setTranslationStatus(true);
    try {
      const cues = target.cues.filter(({ text }) => text.trim()).map(({ id, text }) => ({ id, text }));
      const output = await createAgentClient().translate(cues, job.signal);
      if (job.signal.aborted || documentData !== target) return;
      translationJob = undefined;
      translations = output.translations;
      void writeStored(translationKey(target.context), { savedAt: target.savedAt, translations }).catch(() => {});
      present(target, { ...panel.getState(), bilingual: true });
      saveReading();
    } catch {
      if (!job.signal.aborted && documentData === target) panel.setTranslationStatus(false, '翻译失败，点击重试');
      return;
    } finally {
      if (translationJob === job) translationJob = undefined;
    }
    panel.setTranslationStatus(false);
  }
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
    const updated = { ...original, savedAt: original.savedAt ?? Date.now(), people, agentResult: result, avatars };
    if (translations && original.savedAt === undefined) {
      await writeStored(translationKey(original.context), { savedAt: updated.savedAt, translations }).catch(() => {});
    }
    await writeStored(resultKey(original.context), updated);
    await writeStored(avatarKey(original.context), avatars);
    if (task && !signal?.aborted) {
      const state = documentData ? panel.getState() : undefined;
      if (!documentData) translations = undefined;
      translationJob?.abort();
      translationJob = undefined;
      present(updated, state);
    }
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
