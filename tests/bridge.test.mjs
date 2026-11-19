import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../extension/bridge.js', import.meta.url), 'utf8');
function environment() {
  let handler;
  const messages = [], seeks = [];
  let time = 5;
  const events = new Map();
  const video = {
    paused: false, duration: 100, videoWidth: 1920, videoHeight: 1080,
    get currentTime() { return time; },
    set currentTime(value) {
      time = value; seeks.push(value);
      queueMicrotask(() => events.get('seeked')?.());
    },
    pause() { this.paused = true; },
    async play() { this.paused = false; },
    addEventListener(name, listener) { events.set(name, listener); },
    removeEventListener(name) { events.delete(name); }
  };
  const window = {
    __INITIAL_STATE__: { videoData: { bvid: 'BVtest', aid: 1, pages: [{ page: 1, cid: 2 }] } },
    addEventListener(_name, listener) { handler = listener; },
    postMessage(message) { messages.push(message); }
  };
  const location = { pathname: '/video/BVtest/', href: 'https://www.bilibili.com/video/BVtest/', origin: 'https://www.bilibili.com' };
  vm.runInNewContext(source, { window, location, URL, Number, AbortController, setTimeout, clearTimeout,
    document: {
      querySelector: () => video,
      createElement: () => ({ getContext: () => ({ drawImage() {} }), toDataURL: () => 'data:image/jpeg;base64,frame' })
    }
  });
  return { video, seeks, async request(action, payload) {
    await handler({ source: window, origin: location.origin, data: { channel: 'bili-transcript-request', id: 1, action, payload } });
    return messages.at(-1);
  } };
}

test('页面采帧保留时间戳，结束后恢复播放位置和状态', async () => {
  const page = environment();
  const result = await page.request('framesAt', { key: 'BVtest:2', times: [10000, 20000] });
  assert.equal(result.error, undefined);
  assert.deepEqual(Array.from(result.data, frame => frame.timeMs), [10000, 20000]);
  assert.equal(page.video.currentTime, 5);
  assert.equal(page.video.paused, false);
});

test('采当前帧不等待不会触发的seeked，原暂停状态保持', async () => {
  const page = environment();
  page.video.paused = true;
  const result = await page.request('framesAt', { key: 'BVtest:2', times: [5000] });
  assert.equal(result.data.length, 1);
  assert.equal(page.video.paused, true);
});

test('拒绝其他视频的采帧请求', async () => {
  const page = environment();
  const result = await page.request('framesAt', { key: 'other', times: [10000] });
  assert.match(result.error, /视频已切换/);
  assert.equal(page.seeks.length, 0);
});
