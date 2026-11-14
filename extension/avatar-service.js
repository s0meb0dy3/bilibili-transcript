import { candidateTimes, chooseAvatars, concreteName, cropAvatar, initialAvatar, parsePeople, visionPrompt } from './avatar.js';

function checkAbort(signal) {
  if (signal?.aborted) throw new DOMException('已取消头像提取', 'AbortError');
}

// 采帧、视觉请求与裁剪由调用方注入，不依赖扩展环境。
export async function extractAvatars({
  cues, people = {}, metadata = {}, captureFrames, analyzeFrame,
  signal, onProgress = () => {}, crop = cropAvatar
}) {
  checkAbort(signal);
  const candidates = [...new Set(Object.values(people).map(person => concreteName(person.name)).filter(Boolean))];
  const times = candidateTimes(cues);
  if (!times.length) return {};
  onProgress({ message: '正在采集头像候选画面…' });
  checkAbort(signal);
  const frames = await captureFrames(times.map(item => item.timeMs));
  checkAbort(signal);
  const speakerByTime = new Map(times.map(item => [item.timeMs, item.speakerId]));
  const analyzed = [];
  const queue = frames.filter(frame => speakerByTime.has(frame.timeMs))
    .map(frame => ({ ...frame, speakerId: speakerByTime.get(frame.timeMs) }));
  const total = queue.length;
  let failed = false;
  // 保持三路并发；一路失败后停止队列，并丢弃其他在途结果。
  await Promise.all(Array.from({ length: 3 }, async () => {
    try {
      while (queue.length && !failed) {
        checkAbort(signal);
        const frame = queue.shift();
        const nearbyText = cues.filter(cue => Math.abs(cue.startMs - frame.timeMs) <= 8000)
          .map(cue => `说话人${cue.speakerId}：${cue.text}`).join('\n');
        let detected = [];
        // 只有空结果才重试，每帧最多请求两次。
        for (let attempt = 0; attempt < 2 && !detected.length; attempt++) {
          checkAbort(signal);
          const result = await analyzeFrame({
            model: 'qwen3.8-flash', temperature: 0, max_tokens: 800, thinking: { type: 'disabled' },
            messages: [{ role: 'user', content: [
              { type: 'image_url', image_url: { url: frame.dataUrl } },
              { type: 'text', text: visionPrompt({
                title: metadata.title, description: metadata.description,
                uploader: metadata.owner || metadata.uploader?.name, nearbyText, candidates
              }) }
            ] }]
          });
          checkAbort(signal);
          if (failed) return;
          detected = parsePeople(result.content);
        }
        analyzed.push({ speakerId: frame.speakerId, timeMs: frame.timeMs, dataUrl: frame.dataUrl, people: detected });
        onProgress({ message: `正在分析头像画面（${analyzed.length}/${total}）…`, completed: analyzed.length, total });
      }
    } catch (error) {
      failed = true;
      throw error;
    }
  }));
  checkAbort(signal);
  const picks = chooseAvatars(analyzed, people);
  const avatars = {};
  for (const [speakerId, pick] of Object.entries(picks)) {
    checkAbort(signal);
    const person = people[speakerId];
    if (!pick) {
      const name = String(person?.name ?? '').trim();
      const number = Number(speakerId);
      const fallback = name ? Array.from(name)[0] : Number.isFinite(number) ? String(number + 1) : '?';
      avatars[speakerId] = initialAvatar(fallback, speakerId);
      continue;
    }
    const frame = analyzed.find(item => item.timeMs === pick.timeMs);
    const portrait = frame.people.filter(item => item.name && item.name !== '不确定').length >= 3;
    try {
      avatars[speakerId] = await crop(frame.dataUrl, pick.box, { portrait });
      checkAbort(signal);
    } catch (error) {
      checkAbort(signal);
      if (error.name === 'AbortError') throw error;
      avatars[speakerId] = initialAvatar(person?.name, speakerId);
    }
  }
  return avatars;
}
