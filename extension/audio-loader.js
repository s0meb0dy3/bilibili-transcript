// 在页面下载音频，再分片取回，避开 CDN 防盗链和扩展消息大小限制。
export async function loadPageAudio({ request, context, signal }) {
  signal?.throwIfAborted();
  const target = { tabId: context.tabId, key: context.key };
  const info = await request('audioInfo', target);
  signal?.throwIfAborted();
  const parts = [];
  let offset = 0;
  while (offset < info.size) {
    const chunk = await request('audioChunk', { ...target, offset });
    signal?.throwIfAborted();
    const bytes = Uint8Array.from(atob(chunk.base64), character => character.charCodeAt(0));
    if (!bytes.length) throw new Error('音频分片为空，请重新转写');
    parts.push(bytes);
    offset += bytes.length;
    if (chunk.done) break;
  }
  if (offset !== info.size) throw new Error('音频分片不完整，请重新转写');
  return new Blob(parts, { type: info.type });
}
