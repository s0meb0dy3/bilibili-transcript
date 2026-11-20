import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { createFaceCapture } from '../extension/face-capture.js';
import { createTabBridge } from '../extension/tabs.js';

const jpeg = time => `data:image/jpeg;base64,/9j/${time}`;
const detection = (originX, originY, width, height, score) => ({
  boundingBox: { originX, originY, width, height }, categories: [{ score }]
});
const stubs = {
  getDetector: async () => ({ detect: () => ({ detections: [detection(-10, 25, 60, 100, .75)] }) }),
  decode: async () => ({ width: 100, height: 100 })
};

test('detects every available frame and selects three uniformly by sorted actual times', async () => {
  const capture = createFaceCapture({
    ...stubs,
    captureFrames: async times => {
      assert.deepEqual(times, [0, 1000, 2000, 3000, 4000, 5000]);
      return [4990, 30, 1040, 3030, 4040, 4040].map(timeMs => ({ timeMs, dataUrl: jpeg(timeMs) }));
    }
  });
  const { frames } = await capture([5000, 0, 2000, 1000, 3000, 1000, 4000, -1]);
  assert.deepEqual(frames.map(frame => frame.timeMs), [30, 1040, 3030, 4040, 4990]);
  assert.deepEqual(frames.map(frame => frame.image), ['/9j/30', undefined, '/9j/3030', undefined, '/9j/4990']);
  assert.ok(frames.every(frame => !Object.hasOwn(frame, 'speakerId')));
  assert.deepEqual(frames[0].faces, [{ box: [0, .25, .5, .75], score: .75 }]);
});

test('selects screenshots only from frames with faces while preserving all detections', async () => {
  const samples = Array.from({ length: 20 }, (_, i) => (i + 2) * 1000);
  for (const [faceTimes, expected] of [
    [[4000, 5000, 6000, 8000, 9000], [4000, 6000, 9000]],
    [[4000, 9000], [4000, 9000]],
    [[], []]
  ]) {
    const capture = createFaceCapture({
      captureFrames: async times => times.map(timeMs => ({ timeMs, dataUrl: jpeg(timeMs) })),
      decode: async url => ({ width: 100, height: 100, timeMs: Number(url.split('/').at(-1)) }),
      getDetector: async () => ({ detect: ({ timeMs }) => ({
        detections: faceTimes.includes(timeMs) ? [detection(10, 10, 20, 20, .75)] : []
      }) })
    });
    const { frames } = await capture(samples);
    assert.deepEqual(frames.map(frame => frame.timeMs), samples);
    assert.deepEqual(frames.filter(frame => frame.faces.length).map(frame => frame.timeMs), faceTimes);
    assert.deepEqual(frames.filter(frame => frame.image).map(frame => frame.timeMs), expected);
  }
});

test('batches frame requests without dropping samples past the bridge limit', async () => {
  const samples = Array.from({ length: 42 }, (_, i) => i * 1000);
  const batches = [];
  const controller = new AbortController();
  const capture = createFaceCapture({ ...stubs, captureFrames: async (times, signal) => {
    assert.equal(signal, controller.signal);
    batches.push(times);
    return times.map(timeMs => ({ timeMs, dataUrl: jpeg(timeMs) }));
  } });
  const { frames } = await capture(samples, controller.signal);
  assert.ok(batches.length > 1);
  assert.deepEqual(batches.flat(), samples);
  assert.deepEqual(frames.filter(frame => frame.image).map(frame => frame.timeMs), [0, 21000, 41000]);
});

test('skips detector initialization for empty samples and stops on cancellation', async () => {
  const controller = new AbortController();
  const capture = createFaceCapture({
    ...stubs,
    captureFrames: async () => {
      controller.abort();
      return [{ timeMs: 0, dataUrl: jpeg(0) }];
    },
    decode: () => assert.fail('cancelled frames should not be decoded')
  });
  assert.deepEqual(await createFaceCapture({ getDetector: () => assert.fail('nothing to detect') })([]), { frames: [] });
  await assert.rejects(capture([0], controller.signal), { name: 'AbortError' });
  await assert.rejects(capture([0], controller.signal), { name: 'AbortError' });
});

test('aborting framesAt sends cancellation for the same capture and tab', async () => {
  const messages = [];
  let resolveCapture;
  const capture = createTabBridge({ sendMessage: async (tabId, message) => {
    messages.push({ tabId, ...message });
    if (message.action === 'framesAt') return new Promise(resolve => { resolveCapture = resolve; });
    resolveCapture({ ok: false, error: 'capture aborted' });
    return { ok: true };
  } });
  const controller = new AbortController();
  const pending = capture('framesAt', { tabId: 27, key: 'video', times: [0] }, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual(messages.map(({ tabId, action }) => [tabId, action]), [[27, 'framesAt'], [27, 'cancelFramesAt']]);
  assert.equal(messages[0].payload.captureId, messages[1].payload.captureId);
});

async function createPageBridge(video) {
  let receive;
  const responses = new Map();
  const window = {
    __INITIAL_STATE__: { videoData: { bvid: 'BVtest', pages: [{ page: 1, cid: 1 }] } },
    addEventListener: (_, listener) => { receive = listener; },
    postMessage: message => responses.set(message.id, message)
  };
  const location = { origin: 'https://www.bilibili.com', pathname: '/video/BVtest', href: 'https://www.bilibili.com/video/BVtest' };
  const document = { querySelector: () => video, createElement: () => ({ getContext: () => ({ drawImage() {} }), toDataURL: () => jpeg(0) }) };
  vm.runInNewContext(await readFile(new URL('../extension/bridge.js', import.meta.url), 'utf8'), {
    window, location, document, URL, AbortController, AbortSignal, clearTimeout, setTimeout
  });
  return async (action, payload) => {
    await receive({ source: window, origin: location.origin, data: { id: action, channel: 'bili-transcript-request', action, payload } });
    return responses.get(action);
  };
}

function videoAt(time, { persistSeek = false } = {}) {
  class Video extends EventTarget {
    duration = 4;
    videoWidth = 128;
    videoHeight = 72;
    seeking = persistSeek;
    paused = false;
    pause() { this.paused = true; }
    async play() { this.paused = false; }
    set currentTime(value) {
      time = value;
      if (!persistSeek) queueMicrotask(() => this.dispatchEvent(new Event('seeked')));
    }
    get currentTime() { return time; }
  }
  return new Video();
}

test('page captures the actual clamped timestamp and restores previous playback', async () => {
  const video = videoAt(2);
  const send = await createPageBridge(video);
  const response = await send('framesAt', { key: 'BVtest:1', times: [4000, 5000] });
  assert.deepEqual(Array.from(response.data, frame => frame.timeMs), [3950]);
  assert.equal(video.currentTime, 2);
  assert.equal(video.paused, false);
});

test('page cancellation interrupts seek without waiting for its timeout', async () => {
  const video = videoAt(2, { persistSeek: true });
  const send = await createPageBridge(video);
  const pending = send('framesAt', { key: 'BVtest:1', captureId: 'capture', times: [3000, 4000] });
  assert.equal(video.currentTime, 3);
  await send('cancelFramesAt', { captureId: 'capture' });
  assert.match((await pending).error, /aborted/i);
  assert.equal(video.currentTime, 2);
  assert.equal(video.paused, false);
});
