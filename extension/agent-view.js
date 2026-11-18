import { createAgentClient } from './agent-client.js';

// 页面仅供素材，转写与模型调用交给本地服务。
export function createAgentView({ getDocument, loadAudio, onProgress, onResult }) {
  let controller;
  async function analyze() {
    const original = getDocument();
    const active = controller = new AbortController();
    const { signal } = active;
    const client = createAgentClient();
    let taskId;
    try {
      const task = original.cues?.length
        ? await client.start({ context: original.context, cues: original.cues }, { signal })
        : await client.startContext(original.context, { signal });
      taskId = task.id;
      if (!original.cues?.length) {
        onProgress('正在获取音频…');
        const audio = await loadAudio(original.context, signal);
        signal.throwIfAborted();
        onProgress('正在上传音频…');
        await client.uploadAudio(taskId, audio, signal);
      }
      await client.watch(taskId, event => {
        if (signal.aborted || event.type !== 'status') return;
        if (event.data.status === 'transcribing') onProgress('正在转写…');
        if (event.data.status === 'analyzing') onProgress('正在分析…');
      }, signal);
      const completed = await client.get(taskId, signal);
      signal.throwIfAborted();
      if (!completed.result) throw new Error(completed.error || '分析未完成');
      const transcript = original.cues?.length ? original : completed.document;
      await onResult(completed.result, transcript, signal);
    } catch (error) {
      if (taskId) client.cancel(taskId).catch(() => {});
      if (!signal.aborted) throw error;
    } finally {
      if (controller === active) controller = null;
    }
  }
  return { analyze, cancel: () => controller?.abort() };
}
