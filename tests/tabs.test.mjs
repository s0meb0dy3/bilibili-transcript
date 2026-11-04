import test from 'node:test';
import assert from 'node:assert/strict';
import { createTabBridge } from '../extension/tabs.js';

function environment() {
  let tab = { id: 10, windowId: 2, url: 'https://www.bilibili.com/video/BVexample?p=1' };
  const queries = [];
  const messages = [];
  let response = async () => ({ ok: true, data: { context: { key: 'BVexample:1' } } });
  const request = createTabBridge({
    query: async query => { queries.push(query); return tab ? [tab] : []; },
    sendMessage: async (tabId, message) => { messages.push({ tabId, message }); return response(message); }
  });
  return {
    request, queries, messages,
    setTab: value => { tab = value; },
    setResponse: handler => { response = handler; }
  };
}

test('snapshot queries the active tab in the current window and returns its video context', async () => {
  const bridge = environment();
  const snapshot = await bridge.request('snapshot');
  assert.deepEqual(bridge.queries, [{ active: true, currentWindow: true }]);
  assert.deepEqual(bridge.messages, [{ tabId: 10, message: {
    channel: 'bili-transcript-tab', action: 'snapshot', payload: {}
  } }]);
  assert.deepEqual(snapshot, {
    tabId: 10, windowId: 2, url: 'https://www.bilibili.com/video/BVexample?p=1',
    available: true, context: { key: 'BVexample:1' }
  });
});

test('unsupported pages and missing active tabs never receive snapshot messages', async () => {
  const bridge = environment();
  for (const url of ['https://example.com/video/BVexample', 'https://www.bilibili.com/', 'chrome://newtab/', 'https://www.bilibili.com.evil.test/video/BVexample']) {
    bridge.setTab({ id: 20, windowId: 2, url });
    const snapshot = await bridge.request('snapshot');
    assert.equal(snapshot.available, false);
    assert.equal(snapshot.context, null);
    assert.equal(snapshot.url, url);
  }
  bridge.setTab(null);
  const snapshot = await bridge.request('snapshot');
  assert.equal(snapshot.available, false);
  assert.equal(snapshot.context, null);
  assert.equal(bridge.messages.length, 0);
});

test('tracks, subtitles and playback preserve their explicit tab and video key', async () => {
  const bridge = environment();
  const data = { timeMs: 1200, paused: true, key: 'BVexample:1' };
  bridge.setResponse(async () => ({ ok: true, data }));
  for (const action of ['tracks', 'subtitle', 'playback']) {
    const payload = { tabId: 20, key: 'BVexample:1', ...(action === 'subtitle' ? { url: 'https://subtitle.test/a' } : {}) };
    assert.equal(await bridge.request(action, payload), data);
    assert.deepEqual(bridge.messages.at(-1), { tabId: 20, message: {
      channel: 'bili-transcript-tab', action, payload
    } });
  }
  assert.equal(bridge.queries.length, 0);
});

test('sendMessage connection failures explain how to retry and allow a later successful request', async () => {
  const bridge = environment();
  bridge.setResponse(async () => { throw new Error('Receiving end does not exist'); });
  await assert.rejects(bridge.request('snapshot'), /无法连接视频页.*刷新.*重试/);
  bridge.setResponse(async () => ({ ok: true, data: { context: { key: 'BVexample:1' } } }));
  assert.equal((await bridge.request('snapshot')).context.key, 'BVexample:1');
});

test('bridge returns page errors and explains missing responses', async () => {
  const bridge = environment();
  bridge.setResponse(async () => ({ ok: false, error: '视频已切换，请重试' }));
  await assert.rejects(bridge.request('tracks', { tabId: 10, key: 'BVexample:1' }), /视频已切换，请重试/);
  bridge.setResponse(async () => undefined);
  await assert.rejects(bridge.request('snapshot'), /视频页没有响应.*刷新.*重试/);
});

test('seek checks the active tab and routes milliseconds, play and key unchanged', async () => {
  const bridge = environment();
  const payload = { tabId: 10, key: 'BVexample:1', milliseconds: 4140, play: true };
  bridge.setResponse(async () => ({ ok: true, data: { playBlocked: true } }));
  assert.deepEqual(await bridge.request('seek', payload), { playBlocked: true });
  assert.deepEqual(bridge.queries, [{ active: true, currentWindow: true }]);
  assert.deepEqual(bridge.messages, [{ tabId: 10, message: {
    channel: 'bili-transcript-tab', action: 'seek', payload
  } }]);
});

test('seek rejects the previous tab even when the new tab shows the same video', async () => {
  const bridge = environment();
  bridge.setTab({ id: 20, windowId: 2, url: 'https://www.bilibili.com/video/BVexample?p=1' });
  await assert.rejects(bridge.request('seek', { tabId: 10, key: 'BVexample:1', milliseconds: 1000 }), /标签页已切换.*重试/);
  assert.equal(bridge.messages.length, 0);
  bridge.setTab(null);
  await assert.rejects(bridge.request('seek', { tabId: 10, key: 'BVexample:1', milliseconds: 1000 }), /标签页已切换/);
  assert.equal(bridge.messages.length, 0);
});
