import { readStored, writeStored } from './subtitles.js';
import { createTabBridge } from './tabs.js';
import { TranscriptPanel, activeCueAt, toMarkdown } from './panel.js';
import { transcribeAudio } from './asr.js';
import { inferPeople } from './identity.js';
import { normalizeTranscript, paragraphize } from './transcript.js';

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
const taskKey = (ctx, model) => `asr-task:v1:${ctx.key}:${model}`;
const store = { get: readStored, set: writeStored };

function cancel(message = '') {
  task?.abort();
  task = null;
  panel.setSemanticState({ message });
}

function clear() {
  cancel();
  revision++;
  documentData = null;
  panel.clear();
}

function present(data) {
  documentData = data;
  panel.renderDocument(data);
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
    if (cached) present({ ...cached, context: target });
    else panel.setStatus('点击“转写音频”，上传原始音轨并识别文字与说话人。');
  } catch {
    if (token === revision) panel.setStatus('本地结果读取失败，请重试', { error: true, retry: true });
  }
}

async function transcribe() {
  if (!context || task) return;
  const target = context;
  const token = revision;
  const controller = new AbortController();
  task = controller;
  const current = () => token === revision && task === controller && !controller.signal.aborted;
  panel.setSemanticState({ busy: true, message: '正在准备原始音频…' });
  try {
    const config = await readStored('bailianConfig');
    if (!config?.apiKey) throw new Error('请右键工具栏插件图标 → 设置，保存百炼 API key');
    const savedTask = await readStored(taskKey(target, config.model || 'qwen-audio-3.1-asr-flash-filetrans'));
    if (!current()) return;
    const raw = await transcribeAudio({
      loadAudio: async () => {
        if (savedTask?.task_id) return savedTask;
        const info = await request('audioInfo', { tabId: target.tabId, key: target.key });
        if (!current()) throw new DOMException('已取消', 'AbortError');
        const parts = [];
        let offset = 0;
        while (offset < info.size) {
          const chunk = await request('audioChunk', { tabId: target.tabId, key: target.key, offset });
          if (!current()) throw new DOMException('已取消', 'AbortError');
          const binary = atob(chunk.base64);
          parts.push(Uint8Array.from(binary, character => character.charCodeAt(0)));
          offset += parts.at(-1).length;
          if (chunk.done) break;
        }
        return new Blob(parts, { type: info.type });
      },
      config, signal: controller.signal, store,
      taskKey: taskKey(target, config.model || 'qwen-audio-3.1-asr-flash-filetrans'),
      onProgress: ({ message }) => { if (current()) panel.setSemanticState({ busy: true, message }); }
    });
    if (!current()) return;
    const cues = normalizeTranscript(raw);
    if (!cues.length) await writeStored(taskKey(target, config.model || 'qwen-audio-3.1-asr-flash-filetrans'), null);
    let data = { context: target, raw, cues, paragraphs: paragraphize(cues), savedAt: Date.now(), track: { name: '百炼语音转写', language: 'asr', automatic: false }, source: '百炼 ASR · 匿名说话人 · 自动识别可能有误' };
    present(data);
    await writeStored(resultKey(target), data);
    if (!current() || !cues.length) return;
    // Automatically infer speaker names after transcription; a failure keeps the transcript.
    panel.setSemanticState({ busy: true, message: '转写完成，正在推断发言人…' });
    try {
      const inferred = await inferSpeakers(data, current, controller.signal);
      if (!current()) return;
      data = inferred;
      present(data);
      await writeStored(resultKey(target), data);
      if (current()) panel.setSemanticState({ message: '转写与发言人推断完成。名称为推测；悬停标签可查看原文依据。' });
    } catch (error) {
      if (current()) panel.setSemanticState({ message: `转写完成，但发言人推断未成功：${error.message}。可稍后在“推断发言人”重试。` });
    }
  } catch (error) {
    if (current()) panel.setSemanticState({ error: true, message: `${error.message}。已有稿件保留；可重试或续接已提交任务。` });
  } finally {
    if (task === controller) { task = null; panel.setBusy(false); }
  }
}

async function inferSpeakers(original, current, signal) {
  const config = await chrome.runtime.sendMessage({ action: 'modelConfig' });
  if (!config?.ok || !config.data.configured) throw new Error('请先在设置中保存 DeepSeek API key');
  const metadata = await request('identityMetadata', { tabId: original.context.tabId, key: original.context.key });
  if (!current()) throw new DOMException('已取消', 'AbortError');
  const people = await inferPeople({
    cues: original.cues, metadata, model: config.data.model, signal, store,
    callModel: async body => {
      const result = await chrome.runtime.sendMessage({ action: 'complete', request: body });
      if (!result?.ok) throw new Error(result?.error || '名称推断请求失败');
      return result.data;
    }
  });
  return { ...original, people, identityMetadata: metadata };
}

async function identify() {
  if (!documentData || task) return;
  const original = documentData;
  const token = revision;
  const controller = new AbortController();
  task = controller;
  const current = () => token === revision && task === controller && !controller.signal.aborted;
  panel.setSemanticState({ busy: true, message: '正在结合视频资料和发言推断名称…' });
  try {
    const data = await inferSpeakers(original, current, controller.signal);
    if (!current()) return;
    present(data);
    await writeStored(resultKey(original.context), data);
    if (current()) panel.setSemanticState({ message: '名称推断完成。名称为推测；悬停标签可查看原文依据，无法确定的保留未知。' });
  } catch (error) {
    if (current()) panel.setSemanticState({ error: true, message: `${error.message}，原稿已保留。` });
  } finally {
    if (task === controller) { task = null; panel.setBusy(false); }
  }
}

const panel = new TranscriptPanel(chrome.runtime.getURL('panel.css'), {
  refresh: () => context ? load() : syncContext(),
  transcribe,
  identify,
  cancelSemantic: () => cancel('已暂停本地处理；已提交的云端任务可能继续运行，再次转写可续接。'),
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
  export: () => {
    if (!documentData) return;
    const url = URL.createObjectURL(new Blob([toMarkdown(documentData)], { type: 'text/markdown;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = `${context.bvid}-P${context.part}-asr.md`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
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
