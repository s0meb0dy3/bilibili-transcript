import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { segmentCues, SEGMENTATION_VERSION } from '../extension/segmentation.js';
import { normalizeSubtitles, cacheKey, preferenceKey } from '../extension/subtitles.js';
import { activeCueAt } from '../extension/panel.js';
import { runSemanticSegmentation, semanticToDisplay } from '../extension/semantic.js';

const source = (await readFile(new URL('../extension/app.js', import.meta.url), 'utf8')).replace(/^import .+;\n/gm, '');
const flush = () => new Promise(resolve => setImmediate(resolve));
const raw = text => ({ body: [{ sid: 1, from: 0, to: 2, content: text }] });
const a = { id: 'a', language: 'ai-zh', name: '中文', automatic: true, url: 'https://example/a' };
const b = { id: 'b', language: 'zh-CN', name: '中文', automatic: false, url: 'https://example/b' };

async function environment() {
  const storage = new Map();
  const calls = [];
  let context = { key: 'BVexample:1', bvid: 'BVexample', cid: '1', part: 1, title: '测试', partTitle: '上' };
  let tracks = [a, b];
  let subtitle = async payload => raw(`${payload.key}:${payload.url.split('/').at(-1)}。`);
  let metadataError = null;
  let tabId = 10;
  let available = true;
  let playback = async () => ({ timeMs: 0, paused: true, key: context.key });
  let seek = async () => ({ playBlocked: false });
  const listeners = {};
  let complete = async request => {
    const items = JSON.parse(request.messages[1].content).items;
    return { ok: true, data: { response: { paragraphs: [{ start_item: items[0].id, text: items.map(item => item.text).join('') }] } } };
  };
  const sendMessage = async message => {
    if (message.action === 'modelConfig') return { ok: true, data: { configured: true, model: 'deepseek-flash' } };
    if (message.action === 'complete') return complete(message.request);
    return { ok: true, data: null };
  };
  class Panel {
    constructor(_style, handlers) { this.handlers = handlers; this.isOpen = true; this.activeCalls = []; }
    setAvailable(value) { this.available = value; }
    setContext(value) { this.context = value; }
    clear() { this.rendered = null; this.tracks = []; }
    setStatus(message) { this.status = message; }
    setTracks(values, selected) { this.tracks = values; this.selected = selected; }
    renderDocument(value) { this.rendered = value; }
    setFollow() {}
    setActive(value) { this.active = value; this.activeCalls.push(value); }
    setSemanticState(value) { this.semanticState = value; }
  }
  const request = async (action, payload) => {
    calls.push({ action, payload });
    if (action === 'snapshot') return {
      tabId, windowId: 1, url: available ? `https://www.bilibili.com/video/BVexample?p=${context.part}` : 'https://example.com',
      available, context: available ? context : null
    };
    if (action === 'tracks') { if (metadataError) throw new Error(metadataError); return tracks; }
    if (action === 'subtitle') return subtitle(payload);
    if (action === 'playback') return playback(payload);
    if (action === 'seek') return seek(payload);
    throw new Error(`Unexpected request: ${action}`);
  };
  const scope = {
    createTabBridge: () => request, normalizeSubtitles, cacheKey, preferenceKey,
    readStored: async key => storage.get(key),
    writeStored: async (key, value) => storage.set(key, structuredClone(value)),
    segmentCues, SEGMENTATION_VERSION, TranscriptPanel: Panel, activeCueAt,
    runSemanticSegmentation, semanticToDisplay, AbortController, DOMException,
    toMarkdown: () => '', chrome: {
      runtime: { getURL: value => value, sendMessage },
      tabs: Object.fromEntries(['onActivated', 'onUpdated', 'onRemoved'].map(name => [name, {
        addListener: listener => { listeners[name] = listener; }
      }]))
    },
    // The extension document has no player or Bilibili page location.
    document: { querySelector: () => { throw new Error('Side panel must not query a page video'); } },
    setInterval: () => 0, setTimeout, clearTimeout, Date, Blob, URL
  };
  vm.runInNewContext(`${source}\nglobalThis.hooks = {load, syncContext, updatePlayback, panel, getData: () => documentData};`, scope);
  // Startup loads automatically; finish its storage and playback promises first.
  await flush();
  const hooks = scope.hooks;
  assert.ok(hooks.getData(), 'startup should automatically load the active video');
  return {
    ...hooks, storage, calls,
    setTracks: values => { tracks = values; },
    setSubtitle: handler => { subtitle = handler; },
    setError: error => { metadataError = error; },
    setComplete: handler => { complete = handler; },
    setPlayback: handler => { playback = handler; },
    setSeek: handler => { seek = handler; },
    emit: (name, ...args) => listeners[name](...args),
    switchTab: (id, supported = true) => { tabId = id; available = supported; },
    switchPart: part => { context = { ...context, key: `BVexample:${part}`, cid: String(part), part }; }
  };
}

test('cache restores original subtitles without network metadata calls', async () => {
  const app = await environment();
  await app.load();
  const count = app.calls.filter(call => call.action === 'tracks').length;
  await app.load();
  assert.equal(app.calls.filter(call => call.action === 'tracks').length, count);
  assert.match(app.panel.status, /本地缓存/);
  assert.equal(app.getData().track.id, 'a');
});

test('failed refresh preserves the current document and offers an error', async () => {
  const app = await environment();
  await app.load();
  const original = app.getData();
  app.setError('网络失败');
  await app.load({ refresh: true });
  assert.equal(app.getData(), original);
  assert.equal(app.panel.status, '网络失败');
});

test('no Chinese tracks is an explicit empty state', async () => {
  const app = await environment();
  app.setTracks([]);
  await app.load({ refresh: true });
  assert.equal(app.getData(), null);
  assert.match(app.panel.status, /没有可获取的中文字幕/);
});

test('retry preserves a failed newly selected track instead of restoring the old one', async () => {
  const app = await environment();
  await app.load();
  app.setSubtitle(async payload => { if (payload.url.endsWith('/b')) throw new Error('B失败'); return raw('A。'); });
  await app.load({ trackId: 'b' });
  assert.equal(app.getData(), null);
  assert.equal(app.panel.status, 'B失败');
  app.setSubtitle(async () => raw('B恢复。'));
  app.panel.handlers.refresh();
  await flush();
  assert.equal(app.getData().track.id, 'b');
  assert.equal(app.getData().paragraphs[0].text, 'B恢复。');
});

test('late results from the previous part cannot replace the new part', async () => {
  const app = await environment();
  let finishOld;
  app.setSubtitle(payload => payload.key.endsWith(':1')
    ? new Promise(resolve => { finishOld = resolve; })
    : Promise.resolve(raw('第二P。')));
  app.storage.delete('transcript:BVexample:1:a');
  const pending = app.load({ refresh: true });
  await flush();
  app.switchPart(2);
  await app.syncContext();
  await flush();
  assert.equal(app.getData().context.part, 2);
  finishOld(raw('过期第一P。'));
  await pending;
  assert.equal(app.getData().context.part, 2);
  assert.equal(app.getData().paragraphs[0].text, '第二P。');
  assert.equal(app.storage.has('transcript:BVexample:1:a'), false);
});

test('semantic action persists checked paragraphs and restores them from cache', async () => {
  const app = await environment();
  await app.load();
  await app.panel.handlers.semantic();
  assert.ok(app.getData().semantic);
  assert.match(app.panel.semanticState.message, /完成/);
  assert.ok(app.storage.get('transcript:BVexample:1:a').semantic);
  await app.load();
  assert.ok(app.getData().semantic);
  assert.ok(app.getData().paragraphs[0].displayFragments);
});

test('semantic result arriving after part switch cannot replace the new document', async () => {
  const app = await environment();
  await app.load();
  let finish;
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  app.setComplete(() => new Promise(resolve => { finish = resolve; markStarted(); }));
  const pending = app.panel.handlers.semantic();
  await started;
  app.switchPart(2);
  await app.syncContext();
  await flush();
  finish({ ok: true, data: { response: { paragraphs: [{ start_item: 1, text: '迟到结果。' }] } } });
  await pending;
  assert.equal(app.getData().context.part, 2);
  assert.equal(app.getData().semantic, undefined);
});

test('sentence and timestamp navigation route seek to the current tab and video key', async () => {
  const app = await environment();
  await app.panel.handlers.seek(4140);
  await app.panel.handlers.seek(10540, { play: true });
  const seeks = app.calls.filter(call => call.action === 'seek');
  assert.deepEqual(JSON.parse(JSON.stringify(seeks)), [
    { action: 'seek', payload: { tabId: 10, key: 'BVexample:1', milliseconds: 4140, play: false } },
    { action: 'seek', payload: { tabId: 10, key: 'BVexample:1', milliseconds: 10540, play: true } }
  ]);
});

test('blocked playback keeps the seek and explains how to continue', async () => {
  const app = await environment();
  app.setSeek(async () => ({ playBlocked: true }));
  await app.panel.handlers.seek(5000, { play: true });
  assert.equal(app.calls.find(call => call.action === 'seek').payload.milliseconds, 5000);
  assert.match(app.panel.status, /已跳转.*未允许自动播放/);
});

test('switching tabs with the same video immediately clears the old document and reroutes controls', async () => {
  const app = await environment();
  app.switchTab(20);
  app.emit('onActivated', { tabId: 20, windowId: 1 });
  assert.equal(app.getData(), null);
  await app.panel.handlers.seek(1000);
  assert.equal(app.calls.filter(call => call.action === 'seek').length, 0);
  await flush();
  assert.equal(app.getData().context.tabId, 20);
  await app.panel.handlers.seek(2000, { play: true });
  const seek = app.calls.find(call => call.action === 'seek');
  assert.equal(seek.payload.tabId, 20);
  assert.equal(seek.payload.key, 'BVexample:1');
});

test('switching to an unsupported tab clears the transcript without hiding the panel', async () => {
  const app = await environment();
  app.switchTab(20, false);
  app.emit('onActivated', { tabId: 20, windowId: 1 });
  assert.equal(app.getData(), null);
  await flush();
  assert.equal(app.panel.rendered, null);
  assert.equal(app.panel.available, false);
  assert.equal(app.panel.isOpen, true);
  assert.match(app.panel.status, /打开一个 B 站视频/);
});

test('late playback from the previous tab cannot highlight the new tab', async () => {
  const app = await environment();
  let finish;
  app.setPlayback(() => new Promise(resolve => { finish = resolve; }));
  const pending = app.updatePlayback();
  app.switchTab(20);
  app.emit('onActivated', { tabId: 20, windowId: 1 });
  await flush();
  assert.equal(app.getData().context.tabId, 20);
  const highlights = app.panel.activeCalls.length;
  finish({ timeMs: 1000, paused: false, key: 'BVexample:1' });
  await pending;
  assert.equal(app.panel.activeCalls.length, highlights);
});

test('active-tab navigation and removal invalidate immediately; unrelated events do not', async () => {
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
  assert.equal(app.getData().context.part, 2);
  app.switchTab(20, false);
  app.emit('onRemoved', 10);
  assert.equal(app.getData(), null);
  await flush();
  assert.equal(app.panel.available, false);
});

test('tab activation cancels semantic work before the next snapshot resolves', async () => {
  const app = await environment();
  let finish;
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  app.setComplete(() => new Promise(resolve => { finish = resolve; markStarted(); }));
  const pending = app.panel.handlers.semantic();
  await started;
  app.switchTab(20);
  app.emit('onActivated', { tabId: 20, windowId: 1 });
  assert.equal(app.getData(), null);
  await flush();
  finish({ ok: true, data: { response: { paragraphs: [{ start_item: 1, text: '迟到结果。' }] } } });
  await pending;
  assert.equal(app.getData().context.tabId, 20);
  assert.equal(app.getData().semantic, undefined);
});
