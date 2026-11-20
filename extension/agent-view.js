import { createAgentClient } from './agent-client.js';

// 页面仅供素材，转写与模型调用交给本地服务。
export function createAgentView({ getDocument, loadAudio, captureFaces, cropFace, onProgress, onResult }) {
  let controller;
  async function analyze({ inspectFaces = false } = {}) {
    const original = getDocument();
    const active = controller = new AbortController();
    const { signal } = active;
    const client = createAgentClient();
    let taskId;
    const candidates = new Map();
    const seen = new Set();
    let capturing;
    const pendingCaptures = new Set();
    async function capture({ requestId, times, deadline }) {
      const remaining = deadline - Date.now();
      if (!inspectFaces || !captureFaces || seen.has(requestId) || remaining <= 0) return;
      seen.add(requestId);
      capturing?.abort();
      const current = capturing = new AbortController();
      const captureSignal = AbortSignal.any([signal, current.signal, AbortSignal.timeout(remaining)]);
      let frames = [];
      try { ({ frames } = await captureFaces(original.context, times, captureSignal)); } catch { /* 头像失败不影响文本分析 */ }
      if (captureSignal.aborted) return;
      for (const [index, frame] of frames.entries()) {
        if (frame.image) frame.faces.forEach(({ box }, faceIndex) => {
          candidates.set(`${requestId}-${index}-${faceIndex}`, { image: frame.image, box });
        });
      }
      await client.submitFaces(taskId, requestId, frames, captureSignal);
    }
    try {
      const task = original.cues?.length
        ? await client.start({ context: original.context, cues: original.cues }, { signal, inspectFaces: inspectFaces && Boolean(captureFaces) })
        : await client.startContext(original.context, { signal, inspectFaces: inspectFaces && Boolean(captureFaces) });
      taskId = task.id;
      if (!original.cues?.length) {
        onProgress('正在获取音频…');
        const audio = await loadAudio(original.context, signal);
        signal.throwIfAborted();
        onProgress('正在上传音频…');
        await client.uploadAudio(taskId, audio, signal);
      }
      await client.watch(taskId, event => {
        if (signal.aborted) return;
        if (event.type === 'capture_faces') { return capture(event.data); }
        if (event.type !== 'status') return;
        if (event.data.status === 'transcribing') onProgress('正在转写…');
        if (event.data.status === 'analyzing') onProgress('正在分析…');
      }, signal);
      const completed = await client.get(taskId, signal);
      signal.throwIfAborted();
      if (!completed.result) throw new Error(completed.error || '分析未完成');
      const transcript = original.cues?.length ? original : completed.document;
      const avatars = {};
      for (const [id, candidateId] of Object.entries(completed.result.faces || {})) {
        const candidate = candidates.get(candidateId);
        if (!candidate) continue;
        try { avatars[id] = `data:image/jpeg;base64,${await cropFace(candidate.image, candidate.box)}`; } catch { /* 使用默认头像 */ }
      }
      signal.throwIfAborted();
      await onResult(completed.result, transcript, signal, avatars);
    } catch (error) {
      if (taskId) client.cancel(taskId).catch(() => {});
      if (!signal.aborted) throw error;
    } finally {
      capturing?.abort();
      if (controller === active) controller = null;
    }
  }
  return { analyze, cancel: () => controller?.abort() };
}
