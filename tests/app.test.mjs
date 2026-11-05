import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { normalizeTranscript, paragraphize } from '../extension/transcript.js';
import { activeCueAt } from '../extension/panel.js';

// Exercise the app's orchestration without importing its browser-only startup.
const source = (await readFile(new URL('../extension/app.js', import.meta.url), 'utf8')).replace(/^import .+;\n/gm, '');
const flush = () => new Promise(resolve => setImmediate(resolve));
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const resultKey = 'asr-document:v1:BVexample:1';
const defaultModel = 'qwen-audio-3.1-asr-flash-filetrans';
const taskKey = model => `asr-task:v1:BVexample:1:${model}`;
const rawTranscript = () => ({
  file_url: 'https://audio.example/original.m4s?signature=keep-me',
  transcripts: [{ sentences: ['第一句。', '第二句。', '另一位说话人。'].map((text, index) => ({
    begin_time: 4140 + index * 3200, end_time: 6140 + index * 3200,
    text, speaker_id: index < 2 ? 0 : 2,
    words: [{ text, begin_time: 4140 + index * 3200, end_time: 6140 + index * 3200 }]
  })) }]
});
const initialContext = { key: 'BVexample:1', bvid: 'BVexample', cid: '1', part: 1, title: '测试', partTitle: '上' };
function cachedDocument() {
  const raw = rawTranscript();
  const cues = normalizeTranscript(raw);
  return { context: { ...initialContext, tabId: 10 }, raw, cues, paragraphs: paragraphize(cues), savedAt: 123,
    track: { name: '百炼语音转写', language: 'asr', automatic: false }, source: '百炼 ASR' };
}

async function environment({ cached = true, config = { apiKey: 'bailian-key', model: defaultModel }, savedTask, people } = {}) {
  const storage = new Map([['bailianConfig', config], ['settings', { follow: false }]]);
  if (cached) storage.set(resultKey, { ...cachedDocument(), ...(people ? { people } : {}) });
  if (savedTask) storage.set(taskKey(config.model || defaultModel), savedTask);
  const calls = [], reads = [], writes = [], asrCalls = [], identifyCalls = [], messages = [];
  let context = { ...initialContext }, tabId = 10, available = true;
  let readStored = async key => storage.get(key);
  const audioBytes = 'fake-audio-bytes';
  let audioInfo = async () => ({ type: 'audio/mp4', size: audioBytes.length });
  let audioChunk = async payload => ({ base64: btoa(audioBytes.slice(payload.offset || 0)), done: true });
  let transcribe = async () => rawTranscript();
  let identify = async options => {
    await options.callModel({ model: options.model, messages: [] });
    return { '0': { name: '张老师', confidence: 'high', evidence: '第一句。' } };
  };
  let complete = async () => ({ ok: true, data: { response: { paragraph_starts: [1, 2, 3] } } });
  let modelConfig = { ok: true, data: { configured: true, model: 'deepseek-flash' } };
  let playback = async () => ({ timeMs: 4140, paused: true });
  let seek = async () => ({ playBlocked: false });
  const listeners = {}, intervals = [];
  class Panel {
    constructor(_style, handlers) {
      this.handlers = handlers; this.isOpen = true; this.activeCalls = []; this.semanticStates = []; this.busyCalls = [];
    }
    setAvailable(value) { this.available = value; }
    setContext(value) { this.context = value; }
    clear() { this.rendered = null; this.active = null; }
    setStatus(message, options = {}) { this.status = message; this.statusOptions = options; }
    renderDocument(value) { this.rendered = value; }
    setFollow(value) { this.follow = value; }
    setActive(value) { this.active = value; this.activeCalls.push(value); }
    setSemanticState(value) { this.semanticState = value; this.semanticStates.push(value); if ('busy' in value) this.busy = value.busy; }
    setBusy(value) { this.busy = value; this.busyCalls.push(value); }
  }
  const request = async (action, payload) => {
    calls.push({ action, payload });
    if (action === 'snapshot') return { tabId, windowId: 1,
      url: available ? `https://www.bilibili.com/video/BVexample?p=${context.part}` : 'https://example.com',
      available, context: available ? context : null };
    if (action === 'identityMetadata') return { ...context, tabId };
    if (action === 'audioInfo') return audioInfo(payload);
    if (action === 'audioChunk') return audioChunk(payload);
    if (action === 'playback') return playback(payload);
    if (action === 'seek') return seek(payload);
    throw new Error(`Unexpected request: ${action}`);
  };
  const scope = {
    createTabBridge: () => request, TranscriptPanel: Panel, activeCueAt, normalizeTranscript, paragraphize,
    transcribeAudio: options => { asrCalls.push(options); return transcribe(options); },
    inferPeople: options => { identifyCalls.push(options); return identify(options); },
    readStored: async key => { reads.push(key); return readStored(key); },
    writeStored: async (key, value) => { writes.push({ key, value: structuredClone(value) }); storage.set(key, structuredClone(value)); },
    AbortController, DOMException, toMarkdown: () => '',
    chrome: {
      runtime: { getURL: value => value, sendMessage: async message => {
        messages.push(message);
        if (message.action === 'modelConfig') return modelConfig;
        if (message.action === 'complete') return complete(message.request);
        throw new Error(`Unexpected runtime message: ${message.action}`);
      } },
      tabs: Object.fromEntries(['onActivated', 'onUpdated', 'onRemoved'].map(name => [name, {
        addListener: listener => { listeners[name] = listener; }
      }]))
    },
    // The side panel must use the tab bridge, not a video in its own DOM.
    document: { querySelector: () => { throw new Error('Side panel must not query a page video'); } },
    setInterval: (callback, delay) => { intervals.push({ callback, delay }); return intervals.length; },
    setTimeout, clearTimeout, Date, Blob, URL
  };
  vm.runInNewContext(`${source}\nglobalThis.hooks = {load, syncContext, updatePlayback, panel, getData: () => documentData};`, scope);
  await flush();
  return {
    ...scope.hooks, storage, calls, reads, writes, asrCalls, identifyCalls, messages, intervals,
    setIdentify: handler => { identify = handler; },
    setAudioInfo: handler => { audioInfo = handler; }, setAudioChunk: handler => { audioChunk = handler; }, setTranscribe: handler => { transcribe = handler; },
    setComplete: handler => { complete = handler; },
    setModelConfig: value => { modelConfig = value; },
    setReadStored: handler => { readStored = handler; },
    setPlayback: handler => { playback = handler; }, setSeek: handler => { seek = handler; },
    emit: (name, ...args) => listeners[name](...args),
    switchTab: (id, supported = true) => { tabId = id; available = supported; },
    switchPart: part => { context = { ...context, key: `BVexample:${part}`, cid: String(part), part }; }
  };
}

test('startup restores only the local ASR cache and never automatically uploads audio', async () => {
  const app = await environment();
  assert.deepEqual(plain(app.getData()), cachedDocument());
  assert.equal(app.panel.rendered, app.getData());
  assert.equal(app.panel.follow, false);
  assert.deepEqual(app.reads, ['settings', resultKey]);
  assert.deepEqual(app.calls.map(call => call.action), ['snapshot', 'playback']);
  assert.equal(app.asrCalls.length, 0);
  assert.equal(app.messages.length, 0);
  assert.equal(app.writes.length, 0);
  await app.panel.handlers.refresh();
  assert.equal(app.asrCalls.length, 0);
  assert.equal(app.calls.some(call => call.action === 'audioInfo'), false);
});

test('transcription automatically infers speaker names without an extra user action', async () => {
  const app = await environment({ cached: false });
  await app.panel.handlers.transcribe();
  const data = app.getData();
  assert.equal(app.identifyCalls.length, 1);
  assert.ok(data.people);
  assert.equal(data.people['0'].name, '张老师');
  assert.match(app.panel.semanticState.message, /发言人推断完成/);
  assert.deepEqual(app.storage.get(resultKey).people, data.people);
});

test('without a cached document startup waits for explicit user transcription', async () => {
  const app = await environment({ cached: false });
  assert.equal(app.getData(), null);
  assert.equal(app.panel.rendered, null);
  assert.match(app.panel.status, /点击.*转写音频.*上传原始音轨/);
  assert.deepEqual(app.calls.map(call => call.action), ['snapshot']);
  assert.equal(app.asrCalls.length, 0);
  assert.equal(app.writes.length, 0);
});

test('successful empty ASR clears the saved task so retry acquires audio and starts a fresh task', async () => {
  const app = await environment({ savedTask: { task_id: 'completed-empty-task' } });
  const emptyRaw = { transcripts: [{ sentences: [] }] };
  app.setTranscribe(async () => emptyRaw);
  await app.panel.handlers.transcribe();
  assert.equal(app.getData().raw, emptyRaw);
  assert.equal(app.getData().cues.length, 0);
  assert.equal(app.getData().paragraphs.length, 0);
  assert.equal(app.panel.statusOptions.retry, true);
  assert.match(app.panel.status, /未识别到有效语音.*重新转写/);
  assert.equal(app.storage.get(taskKey(defaultModel)), null);
  assert.ok(app.writes.some(write => write.key === taskKey(defaultModel) && write.value === null));
  assert.equal(app.calls.some(call => call.action === 'audioInfo'), false);
  assert.equal(app.panel.busy, false);
  app.setTranscribe(async options => {
    assert.equal(await options.store.get(options.taskKey), null);
    assert.equal(typeof options.loadAudio, 'function');
    await options.store.set(options.taskKey, { task_id: 'new-task' });
    return rawTranscript();
  });
  await app.panel.handlers.transcribe();
  assert.equal(app.asrCalls.length, 2);
  assert.deepEqual(app.storage.get(taskKey(defaultModel)), { task_id: 'new-task' });
  assert.equal(app.getData().cues.length, 3);
});

test('transcribe forwards Bailian configuration, original audio URL, signal and resumable task store', async () => {
  const config = { apiKey: 'secret', model: 'custom-asr', baseUrl: 'https://dashscope.example/api/v1', language: 'zh' };
  const app = await environment({ cached: false, config });
  app.setTranscribe(async options => {
    options.onProgress({ message: '云端任务识别中' });
    assert.equal(app.panel.semanticState.message, '云端任务识别中');
    await options.store.set(options.taskKey, { task_id: 'task-123' });
    assert.deepEqual(await options.store.get(options.taskKey), { task_id: 'task-123' });
    return rawTranscript();
  });
  await app.panel.handlers.transcribe();
  const options = app.asrCalls[0];
  assert.equal(options.config, config);
  assert.equal(typeof options.loadAudio, 'function');
  assert.equal(options.taskKey, taskKey('custom-asr'));
  assert.equal(options.signal.aborted, false);
  assert.ok(app.reads.includes('bailianConfig'));
  assert.ok(app.reads.includes(taskKey('custom-asr')));
  assert.equal(app.panel.busy, false);
  assert.match(app.panel.semanticState.message, /转写.*完成/);
});

test('an existing cloud task resumes without fetching audio and uses the default model task key', async () => {
  const app = await environment({ cached: false, config: { apiKey: 'secret' }, savedTask: { task_id: 'existing-task' } });
  app.setAudioInfo(() => assert.fail('resume must not reacquire audio'));
  await app.panel.handlers.transcribe();
  assert.equal(app.calls.some(call => call.action === 'audioInfo'), false);
  assert.equal(app.asrCalls[0].loadAudio !== undefined, true);
  assert.equal(app.asrCalls[0].taskKey, taskKey(defaultModel));
  assert.deepEqual(await app.asrCalls[0].store.get(taskKey(defaultModel)), { task_id: 'existing-task' });
  assert.ok(app.getData());
});

test('failed submitted tasks are retained so the next user attempt resumes instead of reacquiring audio', async () => {
  const app = await environment();
  const original = app.getData();
  app.setTranscribe(async options => {
    await options.store.set(options.taskKey, { task_id: 'resume-after-network-error' });
    throw new Error('轮询网络失败');
  });
  await app.panel.handlers.transcribe();
  assert.equal(app.getData(), original);
  assert.equal(app.panel.semanticState.error, true);
  assert.match(app.panel.semanticState.message, /轮询网络失败.*已有稿件保留/);
  assert.equal(app.panel.busy, false);
  app.setTranscribe(async () => rawTranscript());
  await app.panel.handlers.transcribe();
  assert.equal(app.calls.filter(call => call.action === 'audioInfo').length, 0);
  assert.equal(app.asrCalls.length, 2);
  assert.equal(typeof app.asrCalls[1].loadAudio, 'function');
});

test('ASR persists original words, millisecond timestamps and anonymous speaker labels with paragraphs', async () => {
  const app = await environment({ cached: false });
  const raw = rawTranscript();
  app.setTranscribe(async () => raw);
  await app.panel.handlers.transcribe();
  const data = app.getData();
  assert.equal(data.raw, raw);
  assert.deepEqual(data.cues.map(cue => cue.speakerId), ['0', '0', '2']);
  assert.deepEqual(data.paragraphs.map(paragraph => paragraph.speakerId), ['0', '2']);
  assert.equal(data.cues[0].startMs, 4140);
  assert.deepEqual(data.cues[0].words, raw.transcripts[0].sentences[0].words);
  assert.match(data.source, /匿名说话人.*可能有误/);
  assert.equal(data.track.language, 'asr');
  assert.deepEqual(app.storage.get(resultKey), plain(data));
  assert.ok(data.savedAt > 123);
  await app.load();
  assert.deepEqual(plain(app.getData()), plain(data));
});

test('transcription failures preserve the existing document and cached manuscript', async () => {
  const app = await environment();
  const original = app.getData(), cached = plain(app.storage.get(resultKey));
  app.setTranscribe(async () => { throw new Error('原始音频获取失败'); });
  await app.panel.handlers.transcribe();
  assert.equal(app.getData(), original);
  assert.equal(app.panel.rendered, original);
  assert.match(app.panel.semanticState.message, /原始音频获取失败.*已有稿件保留/);
  assert.deepEqual(app.storage.get(resultKey), cached);
  assert.equal(app.writes.length, 0);
  assert.equal(app.panel.busy, false);
});

test('missing provider credentials do not acquire or upload audio and keep the cached manuscript', async () => {
  const app = await environment({ config: {} });
  const original = app.getData();
  await app.panel.handlers.transcribe();
  assert.equal(app.getData(), original);
  assert.match(app.panel.semanticState.message, /百炼 API key/);
  assert.equal(app.calls.some(call => call.action === 'audioInfo'), false);
  assert.equal(app.asrCalls.length, 0);
});

test('switching tabs aborts ASR immediately and late results cannot render or persist over the new tab', async () => {
  const app = await environment();
  const old = deferred(), started = deferred();
  app.setTranscribe(options => { started.resolve(options); return old.promise; });
  const pending = app.panel.handlers.transcribe();
  const options = await started.promise;
  app.switchTab(20);
  app.emit('onActivated', { tabId: 20, windowId: 1 });
  assert.equal(options.signal.aborted, true);
  assert.equal(app.getData(), null);
  await app.panel.handlers.seek(1000);
  assert.equal(app.calls.some(call => call.action === 'seek'), false);
  await flush();
  const current = app.getData();
  assert.equal(current.context.tabId, 20);
  old.resolve(rawTranscript());
  await pending;
  assert.equal(app.getData(), current);
  assert.equal(app.panel.rendered, current);
  assert.equal(app.writes.length, 0);
  await app.panel.handlers.seek(2000, { play: true });
  assert.equal(app.calls.find(call => call.action === 'seek').payload.tabId, 20);
});

test('late playback from the previous tab cannot highlight the new tab', async () => {
  const app = await environment();
  const old = deferred();
  app.setPlayback(() => old.promise);
  const pending = app.updatePlayback();
  app.switchTab(20);
  app.emit('onActivated', { tabId: 20, windowId: 1 });
  await flush();
  assert.equal(app.getData().context.tabId, 20);
  const highlights = app.panel.activeCalls.length;
  old.resolve({ timeMs: 10540, paused: false });
  await pending;
  assert.equal(app.panel.activeCalls.length, highlights);
  app.setPlayback(async () => ({ timeMs: 10540, paused: false }));
  await app.updatePlayback();
  assert.equal(app.panel.activeCalls.length, highlights + 1);
  assert.equal(app.panel.active, activeCueAt(app.getData().cues, 10540));
});

test('timestamp seek preserves milliseconds and play flag while sentence seek explicitly plays', async () => {
  const app = await environment();
  await app.panel.handlers.seek(4140);
  await app.panel.handlers.seek(7340, { play: false });
  await app.panel.handlers.seek(10540, { play: true });
  assert.deepEqual(plain(app.calls.filter(call => call.action === 'seek')), [
    { action: 'seek', payload: { tabId: 10, key: initialContext.key, milliseconds: 4140, play: false } },
    { action: 'seek', payload: { tabId: 10, key: initialContext.key, milliseconds: 7340, play: false } },
    { action: 'seek', payload: { tabId: 10, key: initialContext.key, milliseconds: 10540, play: true } }
  ]);
});

test('blocked playback preserves the requested seek and tells the user to continue in the player', async () => {
  const app = await environment();
  app.setSeek(async () => ({ playBlocked: true }));
  await app.panel.handlers.seek(4140, { play: true });
  assert.equal(app.calls.find(call => call.action === 'seek').payload.milliseconds, 4140);
  assert.match(app.panel.status, /已跳转.*播放器继续播放/);
});

test('unsupported tabs clear the manuscript without closing or hiding the panel', async () => {
  const app = await environment();
  app.switchTab(20, false);
  app.emit('onActivated', { tabId: 20, windowId: 1 });
  assert.equal(app.getData(), null);
  await flush();
  assert.equal(app.panel.rendered, null);
  assert.equal(app.panel.available, false);
  assert.equal(app.panel.isOpen, true);
  assert.match(app.panel.status, /打开 B站视频/);
});

test('cached inferred names are passed to the panel without automatically invoking name inference', async () => {
  const people = { '0': { name: '缓存名称', confidence: 'high', evidence: '原文依据' } };
  const app = await environment({ people });
  assert.deepEqual(app.getData().people, people);
  assert.deepEqual(app.panel.rendered.people, people);
  assert.equal(app.identifyCalls.length, 0);
  assert.equal(app.messages.length, 0);
  assert.equal(app.writes.length, 0);
});

test('identify forwards video context and cues, then persists people without changing text or time', async () => {
  const app = await environment();
  const original = app.getData(), snapshot = plain(original);
  const people = { '0': { name: '张老师', confidence: 'high', evidence: '第一句。' } };
  const response = { people };
  app.setComplete(async () => ({ ok: true, data: response }));
  app.setIdentify(async options => {
    assert.equal(options.cues, original.cues);
    assert.deepEqual(plain(options.metadata), plain(original.context));
    assert.equal(options.model, 'deepseek-flash');
    assert.equal(options.signal.aborted, false);
    assert.equal(await options.store.get(resultKey), app.storage.get(resultKey));
    const request = { model: options.model, messages: [{ role: 'user', content: '名称推断' }] };
    assert.equal(await options.callModel(request), response);
    assert.equal(app.messages.at(-1).request, request);
    return people;
  });
  await app.panel.handlers.identify();
  const data = app.getData();
  assert.equal(data.people, people);
  assert.equal(data.raw, original.raw);
  assert.equal(data.cues, original.cues);
  assert.equal(data.paragraphs, original.paragraphs);
  assert.deepEqual(plain(data.identityMetadata), plain(original.context));
  const { people: _people, identityMetadata: _metadata, ...unchanged } = data;
  assert.deepEqual(plain(unchanged), snapshot);
  assert.deepEqual(plain(original), snapshot);
  assert.deepEqual(app.storage.get(resultKey), plain(data));
  assert.equal(app.panel.rendered, data);
  assert.deepEqual(app.messages.map(message => message.action), ['modelConfig', 'complete']);
  assert.match(app.panel.semanticState.message, /名称推断完成/);
  assert.equal(app.panel.busy, false);
  await app.load();
  assert.deepEqual(app.panel.rendered.people, people);
});

test('switching tabs aborts name inference and late names cannot render or persist over the new tab', async () => {
  const people = { '0': { name: '已有名称' } };
  const app = await environment({ people });
  const old = deferred(), started = deferred();
  app.setIdentify(options => { started.resolve(options); return old.promise; });
  const pending = app.panel.handlers.identify();
  const options = await started.promise;
  app.switchTab(20);
  app.emit('onActivated', { tabId: 20, windowId: 1 });
  assert.equal(options.signal.aborted, true);
  assert.equal(app.getData(), null);
  await flush();
  const current = app.getData();
  assert.equal(current.context.tabId, 20);
  old.resolve({ '0': { name: '过期名称' } });
  await pending;
  assert.equal(app.getData(), current);
  assert.equal(app.panel.rendered, current);
  assert.deepEqual(current.people, people);
  assert.deepEqual(app.storage.get(resultKey).people, people);
  assert.equal(app.writes.length, 0);
});

test('name inference failure preserves the manuscript and previously cached names', async () => {
  const app = await environment({ people: { '0': { name: '已有名称' } } });
  const original = app.getData(), snapshot = plain(app.storage.get(resultKey));
  app.setComplete(async () => ({ ok: false, error: '名称服务失败' }));
  await app.panel.handlers.identify();
  assert.equal(app.getData(), original);
  assert.equal(app.panel.rendered, original);
  assert.deepEqual(app.storage.get(resultKey), snapshot);
  assert.equal(app.writes.length, 0);
  assert.equal(app.panel.semanticState.error, true);
  assert.match(app.panel.semanticState.message, /名称服务失败.*原稿已保留/);
  assert.equal(app.panel.busy, false);
});

test('only current-window activation and current-tab navigation or removal invalidate the document', async () => {
  const app = await environment();
  const original = app.getData();
  app.emit('onActivated', { tabId: 99, windowId: 2 });
  app.emit('onUpdated', 99, { url: 'https://example.com' });
  app.emit('onRemoved', 99);
  assert.equal(app.getData(), original);
  app.switchPart(2);
  app.emit('onUpdated', 10, { status: 'loading' });
  assert.equal(app.getData(), null);
  await flush();
  assert.equal(app.panel.context.part, 2);
  app.switchTab(20, false);
  app.emit('onRemoved', 10);
  await flush();
  assert.equal(app.panel.available, false);
});
