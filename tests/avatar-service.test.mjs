import test from 'node:test';
import assert from 'node:assert/strict';
import { extractAvatars } from '../extension/avatar-service.js';
import { candidateTimes, initialAvatar } from '../extension/avatar.js';

const cues = [{ speakerId: '0', startMs: 0, endMs: 9000, text: '张三正在发言' }];
const people = { 0: { name: '张三' } };
const box = { x1: 100, y1: 100, x2: 400, y2: 500 };
const detected = [{ name: '张三', box }];
const framesAt = times => times.map(timeMs => ({ timeMs, dataUrl: `frame:${timeMs}` }));
const options = overrides => ({
  cues, people, captureFrames: async times => framesAt(times),
  analyzeFrame: async () => ({ content: JSON.stringify(detected) }),
  crop: async () => 'cropped-avatar', ...overrides
});

test('保留候选选帧、视觉参数、元数据与附近台词，只处理匹配画面', async () => {
  const requests = [];
  const crops = [];
  const progress = [];
  const allCues = [...cues, { speakerId: '1', startMs: 30000, endMs: 39000, text: '远处台词' }];
  const result = await extractAvatars(options({
    cues: allCues,
    people: { ...people, 1: { name: '主持人' }, 2: { name: '张三（嘉宾）' } },
    metadata: { title: '视频标题', description: '视频简介', uploader: { name: '某频道' } },
    captureFrames: async times => {
      assert.deepEqual(times, candidateTimes(allCues).map(item => item.timeMs));
      return [...framesAt(times), { timeMs: -1, dataUrl: 'ignore-me' }];
    },
    analyzeFrame: async request => {
      requests.push(request);
      return { content: JSON.stringify(detected) };
    },
    crop: async (...args) => { crops.push(args); return 'mock-crop'; },
    onProgress: value => progress.push(value)
  }));
  assert.equal(requests.length, 4);
  const request = requests[0];
  assert.equal(request.model, 'qwen3.8-flash');
  assert.equal(request.temperature, 0);
  assert.equal(request.max_tokens, 800);
  assert.deepEqual(request.thinking, { type: 'disabled' });
  assert.equal(request.messages[0].role, 'user');
  assert.deepEqual(request.messages[0].content[0], { type: 'image_url', image_url: { url: 'frame:3000' } });
  const prompt = request.messages[0].content[1].text;
  for (const text of ['视频标题', '视频简介', '某频道', '说话人0：张三正在发言', '候选人物：张三。']) {
    assert.ok(prompt.includes(text), text);
  }
  assert.ok(!prompt.includes('远处台词'));
  assert.equal(result[0], 'mock-crop');
  assert.deepEqual(crops, [
    ['frame:3000', box, { portrait: false }],
    ['frame:6000', box, { portrait: false }]
  ]);
  assert.equal(progress.at(-1).completed, 4);
  assert.equal(progress.at(-1).total, 4);
});

test('视觉请求最多三并发，队列继续处理剩余画面', async () => {
  const manyCues = Array.from({ length: 4 }, (_, index) => ({
    speakerId: String(index), startMs: index * 9000, endMs: (index + 1) * 9000, text: '发言'
  }));
  const gate = Promise.withResolvers();
  let active = 0;
  let peak = 0;
  let calls = 0;
  await extractAvatars(options({
    cues: manyCues,
    analyzeFrame: async () => {
      calls++;
      active++;
      peak = Math.max(peak, active);
      if (calls === 3) gate.resolve();
      await gate.promise;
      active--;
      return { content: detected };
    }
  }));
  assert.equal(peak, 3);
  assert.equal(calls, 8);
});

test('空结果仅重试一次，仍为空则生成默认头像', async () => {
  const calls = new Map();
  const result = await extractAvatars(options({
    people: { 0: { name: '张三' }, 1: { name: null }, unknown: { name: '' } },
    analyzeFrame: async request => {
      const url = request.messages[0].content[0].image_url.url;
      calls.set(url, (calls.get(url) || 0) + 1);
      return { content: '[]' };
    },
    crop: async () => assert.fail('空结果不应裁剪')
  }));
  assert.deepEqual([...calls.values()], [2, 2]);
  assert.equal(result[0], initialAvatar('张', '0'));
  assert.equal(result[1], initialAvatar('2', '1'));
  assert.equal(result.unknown, initialAvatar('?', 'unknown'));
});

test('空结果第二次成功后可正常裁剪', async () => {
  const calls = new Map();
  const result = await extractAvatars(options({
    analyzeFrame: async request => {
      const url = request.messages[0].content[0].image_url.url;
      const count = (calls.get(url) || 0) + 1;
      calls.set(url, count);
      return { content: count === 1 ? '不是有效人物' : detected };
    }
  }));
  assert.deepEqual([...calls.values()], [2, 2]);
  assert.equal(result[0], 'cropped-avatar');
});

test('三位已命名人物使用人像裁剪，失败时保留原有姓名默认头像', async () => {
  const group = [...detected,
    { name: '李四', box: { x1: 450, y1: 100, x2: 600, y2: 500 } },
    { name: '王五', box: { x1: 650, y1: 100, x2: 900, y2: 500 } }
  ];
  const result = await extractAvatars(options({
    analyzeFrame: async () => ({ content: group }),
    crop: async (_url, actualBox, settings) => {
      assert.deepEqual(actualBox, box);
      assert.deepEqual(settings, { portrait: true });
      throw new Error('mock crop failed');
    }
  }));
  assert.equal(result[0], initialAvatar('张三', '0'));
});

test('视觉请求失败直接抛出，不重试或裁剪', async () => {
  let calls = 0;
  await assert.rejects(extractAvatars(options({
    captureFrames: async times => framesAt(times.slice(0, 1)),
    analyzeFrame: async () => { calls++; throw new Error('mock vision failed'); },
    crop: async () => assert.fail('失败后不应裁剪')
  })), /mock vision failed/);
  assert.equal(calls, 1);
});

test('一路失败后停止队列，在途空结果不重试且不通知进度', async () => {
  const manyCues = Array.from({ length: 4 }, (_, index) => ({
    speakerId: String(index), startMs: index * 9000, endMs: (index + 1) * 9000, text: '发言'
  }));
  const pending = [];
  const settled = [];
  const progress = [];
  const result = extractAvatars(options({
    cues: manyCues,
    onProgress: value => progress.push(value),
    analyzeFrame: () => {
      const request = Promise.withResolvers();
      pending.push(request);
      // 记录在途请求的完成点，测试不依赖定时等待。
      settled.push(request.promise.then(() => {}, () => {}));
      return request.promise;
    },
    crop: async () => assert.fail('失败后不应裁剪')
  }));
  const rejection = assert.rejects(result, /first worker failed/);
  await Promise.resolve();
  assert.equal(pending.length, 3);
  pending[0].reject(new Error('first worker failed'));
  await rejection;
  pending[1].resolve({ content: '[]' });
  pending[2].resolve({ content: detected });
  await Promise.all(settled);
  assert.equal(pending.length, 3);
  assert.equal(progress.length, 1);
});

test('没有候选帧时不调用依赖，people 默认为空', async () => {
  assert.deepEqual(await extractAvatars({
    cues: [], captureFrames: async () => assert.fail('不应采帧'),
    analyzeFrame: async () => assert.fail('不应请求模型')
  }), {});
  assert.deepEqual(await extractAvatars({
    cues, captureFrames: async times => framesAt(times),
    analyzeFrame: async () => ({ content: detected }),
    crop: async () => assert.fail('没有人物不应裁剪')
  }), {});
});

test('开始前取消不采帧', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(extractAvatars(options({
    signal: controller.signal, captureFrames: async () => assert.fail('不应采帧')
  })), { name: 'AbortError' });
});

test('采帧返回前取消，不处理迟到画面', async () => {
  const controller = new AbortController();
  await assert.rejects(extractAvatars(options({
    signal: controller.signal,
    captureFrames: async times => { controller.abort(); return framesAt(times); },
    analyzeFrame: async () => assert.fail('取消后不应请求模型')
  })), { name: 'AbortError' });
});

test('模型返回前取消，不重试、不通知完成或裁剪迟到结果', async () => {
  const controller = new AbortController();
  let calls = 0;
  const progress = [];
  await assert.rejects(extractAvatars(options({
    signal: controller.signal,
    onProgress: value => progress.push(value),
    analyzeFrame: async () => { calls++; controller.abort(); return { content: '[]' }; },
    crop: async () => assert.fail('取消后不应裁剪')
  })), { name: 'AbortError' });
  assert.equal(calls, 1);
  assert.equal(progress.length, 1);
});

for (const rejectCrop of [false, true]) {
  test(`裁剪${rejectCrop ? '失败' : '返回'}前取消，不返回迟到头像或默认头像`, async () => {
    const controller = new AbortController();
    await assert.rejects(extractAvatars(options({
      signal: controller.signal,
      crop: async () => {
        controller.abort();
        if (rejectCrop) throw new Error('late crop error');
        return 'late avatar';
      }
    })), { name: 'AbortError' });
  });
}
