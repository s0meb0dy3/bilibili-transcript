import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { normalizeTranscript, paragraphize } from '../extension/transcript.js';
import { activeCueAt } from '../extension/panel.js';
import { loadPageAudio } from '../extension/audio-loader.js';

const source = (await readFile(new URL('../extension/app.js', import.meta.url), 'utf8')).replace(/^import .+;\n/gm, '');
const flush = () => new Promise(resolve => setImmediate(resolve));
const plain = value => JSON.parse(JSON.stringify(value));
const resultKey = 'asr-document:v1:BVexample:1';
const avatarKey = 'asr-avatars:v1:BVexample:1';
const context0 = { key: 'BVexample:1', bvid: 'BVexample', cid: '1', part: 1, title: '测试', partTitle: '上' };
function documentData() {
  const raw = { transcripts: [{ sentences: [{ begin_time: 1000, end_time: 2000, text: '第一句。', speaker_id: 0, words: [] }] }] };
  const cues = normalizeTranscript(raw);
  return { context: { ...context0, tabId: 10 }, raw, cues, paragraphs: paragraphize(cues), savedAt: 1, track: { name: '本地', language: 'asr' }, source: '本地服务' };
}
async function environment({ cached = true } = {}) {
  const storage = new Map([['settings', { follow: false }]]);
  if (cached) storage.set(resultKey, cached === true ? documentData() : cached);
  const calls = [], reads = [], writes = [], messages = [], listeners = {}, intervals = [];
  let context = { ...context0 }, tabId = 10, available = true;
  let playback = async () => ({ timeMs: 1000, paused: true });
  let seek = async () => ({ playBlocked: false });
  let agentAnalyze = async () => {};
  let agentCancel = () => {};
  let agentOptions;
  class Panel {
    constructor(_style, handlers) { this.handlers = handlers; this.aside = { insertBefore() {} }; this.isOpen = true; this.activeCalls = []; }
    setAvailable(v) { this.available = v; } setContext(v) { this.context = v; } clear() { this.rendered = null; this.active = null; }
    setStatus(m, o = {}) { this.status = m; this.statusOptions = o; } renderDocument(v) { this.rendered = v; }
    setFollow(v) { this.follow = v; } setActive(v) { this.active = v; this.activeCalls.push(v); }
    setTaskState(v) { this.taskState = v; } setSummary(v) { this.summary = v; }
  }
  const request = async (action, payload) => {
    calls.push({ action, payload });
    if (action === 'snapshot') return { tabId, windowId: 1, url: available ? 'https://bilibili.com/video/BVexample' : 'https://example.com', available, context: available ? context : null };
    if (action === 'identityMetadata') return { uploader: { name: 'UP主', bio: '公开简介' } };
    if (action === 'playback') return playback(payload); if (action === 'seek') return seek(payload);
    throw new Error(`Unexpected request: ${action}`);
  };
  const scope = {
    loadPageAudio, createAgentView: options => { agentOptions = options; return { host: {}, analyze: () => agentAnalyze(options), cancel: () => agentCancel(options) }; },
    createTabBridge: () => request, TranscriptPanel: Panel, activeCueAt,
    readStored: async key => { reads.push(key); return storage.get(key); },
    writeStored: async (key, value) => { writes.push({ key, value: structuredClone(value) }); storage.set(key, structuredClone(value)); },
    toMarkdown: () => '', AbortController, DOMException,
    chrome: { runtime: { getURL: v => v }, tabs: Object.fromEntries(['onActivated', 'onUpdated', 'onRemoved'].map(name => [name, { addListener: fn => { listeners[name] = fn; } }])) },
    document: { querySelector: () => { throw new Error('must not query page video'); } },
    setInterval: (callback, delay) => { intervals.push({ callback, delay }); return intervals.length; }, setTimeout, clearTimeout, Date, Blob, URL
  };
  vm.runInNewContext(`${source}\nglobalThis.hooks = { load, syncContext, updatePlayback, panel, getData: () => documentData };`, scope);
  await flush();
  return { ...scope.hooks, storage, calls, reads, writes, messages, intervals, getAgentOptions: () => agentOptions,
    setAgentAnalyze: fn => { agentAnalyze = fn; }, setAgentCancel: fn => { agentCancel = fn; }, setPlayback: fn => { playback = fn; }, setSeek: fn => { seek = fn; },
    emit: (name, ...args) => listeners[name](...args), switchTab: (id, supported = true) => { tabId = id; available = supported; context = { ...context, tabId: id }; }
  };
}

test('startup restores cached document without cloud calls or key reads', async () => {
  const app = await environment();
  assert.deepEqual(plain(app.getData()), { ...documentData(), avatars: {} });
  assert.deepEqual(app.reads, ['settings', resultKey, avatarKey]);
  assert.deepEqual(app.calls.map(c => c.action), ['snapshot', 'playback']);
  assert.equal(app.messages.length, 0);
});

test('start analysis only calls agentView.analyze and does not read credentials', async () => {
  const app = await environment(); let called = 0;
  app.setAgentAnalyze(() => { called++; });
  await app.panel.handlers.analyze();
  assert.equal(called, 1); assert.equal(app.reads.includes('bailianConfig'), false); assert.equal(app.reads.includes('deepseekConfig'), false);
});

test('cancel propagates to agent view', async () => {
  const app = await environment(); let cancelled = 0; app.setAgentCancel(() => { cancelled++; });
  app.panel.handlers.cancelTask(); assert.equal(cancelled, 1);
});

test('分析使用缓存原稿和 UP 主资料，保存新结果并展示摘要', async () => {
  const app = await environment();
  const result = { speakers: { '0': '张老师' }, summary: '开场介绍。' };
  app.setAgentAnalyze(async ({ getDocument, onResult }) => {
    const original = getDocument();
    assert.equal(original.context.uploader.bio, '公开简介');
    assert.equal(original.cues[0].text, '第一句。');
    await onResult(result, original, new AbortController().signal);
  });
  await app.panel.handlers.analyze();
  const updated = app.getData();
  assert.equal(updated.people['0'].name, '张老师');
  assert.deepEqual(updated.agentResult, result);
  assert.equal(app.panel.summary, result.summary);
  assert.equal(app.storage.get(resultKey).agentResult.summary, result.summary);
  assert.deepEqual(app.storage.get(avatarKey), {});
});

test('恢复缓存时直接显示摘要，不再请求模型或 UP 主资料', async () => {
  const app = await environment({ cached: { ...documentData(), agentResult: { summary: '上次摘要' } } });
  assert.equal(app.panel.summary, '上次摘要');
  assert.deepEqual(app.calls.map(c => c.action), ['snapshot', 'playback']);
});

test('playback sync and seek preserve timestamps and play flag', async () => {
  const app = await environment();
  await app.panel.handlers.seek(1000); await app.panel.handlers.seek(2000, { play: true });
  assert.deepEqual(plain(app.calls.filter(c => c.action === 'seek').map(c => c.payload)), [
    { tabId: 10, key: context0.key, milliseconds: 1000, play: false }, { tabId: 10, key: context0.key, milliseconds: 2000, play: true }
  ]);
  assert.equal(app.panel.active, activeCueAt(app.getData().cues, 1000));
});

test('unsupported tabs isolate and clear the manuscript', async () => {
  const app = await environment(); app.switchTab(20, false); app.emit('onActivated', { tabId: 20, windowId: 1 }); await flush();
  assert.equal(app.getData(), null); assert.equal(app.panel.available, false); assert.equal(app.panel.isOpen, true); assert.match(app.panel.status, /打开 B站视频/);
});

test('switching tabs cancels analysis and prevents stale rendering', async () => {
  const app = await environment(); let cancelled = 0; app.setAgentCancel(() => { cancelled++; });
  app.panel.handlers.cancelTask(); app.switchTab(20); app.emit('onActivated', { tabId: 20, windowId: 1 }); await flush();
  assert.ok(cancelled >= 1); assert.equal(app.getData().context.tabId, 20);
});
