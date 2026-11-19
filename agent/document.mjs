// 原文只读：模型输出只包含标注和摘要，不回写字幕。
export function prepareDocument(document) {
  if (!document || typeof document !== 'object' || !Array.isArray(document.cues) || !document.cues.length) throw new Error('document.cues 必须包含完整句子');
  const ids = new Set();
  const cues = document.cues.map(cue => {
    if (!cue || typeof cue.id !== 'string' || !cue.id || ids.has(cue.id) || typeof cue.text !== 'string') throw new Error('cue 必须有唯一字符串 id 和 text');
    if (!Number.isFinite(cue.startMs) || !Number.isFinite(cue.endMs) || cue.startMs < 0 || cue.endMs < cue.startMs) throw new Error('cue 时间范围无效');
    ids.add(cue.id);
    return { id: cue.id, speakerId: cue.speakerId == null || cue.speakerId === '' ? 'unknown' : String(cue.speakerId), startMs: cue.startMs, endMs: cue.endMs, text: cue.text };
  });
  return { cues, speakerIds: [...new Set(cues.map(cue => cue.speakerId))] };
}

export function resultSchema({ speakerIds }) {
  const label = { type: 'string', minLength: 1 };
  return {
    type: 'object', additionalProperties: false, required: ['speakers', 'summary'],
    properties: {
      speakers: {
        type: 'object', additionalProperties: false, required: speakerIds,
        properties: Object.fromEntries(speakerIds.map(id => [id, label]))
      },
      summary: label,
      faces: {
        type: 'object', additionalProperties: false,
        properties: Object.fromEntries(speakerIds.map(id => [id, { anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] }]))
      }
    }
  };
}

export function validateResult(result, { speakerIds }) {
  const { speakers, summary } = result || {};
  if (!speakers || Array.isArray(speakers) || typeof speakers !== 'object' ||
      Object.keys(speakers).length !== speakerIds.length ||
      speakerIds.some(id => !Object.hasOwn(speakers, id) || typeof speakers[id] !== 'string' || !speakers[id].trim())) {
    throw new Error(`speakers 必须覆盖全部原始 speakerId（${speakerIds.join('、')}），不能添加编号或留空`);
  }
  if (typeof summary !== 'string' || !summary.trim() || Object.keys(result).some(key => !['speakers', 'summary', 'faces'].includes(key))) throw new Error('只提交 speakers、可选 faces 和非空 summary');
  if (result.faces !== undefined && (Array.isArray(result.faces) || !result.faces || typeof result.faces !== 'object' || Object.keys(result.faces).length !== speakerIds.length || speakerIds.some(id => !Object.hasOwn(result.faces, id) || (result.faces[id] !== null && (typeof result.faces[id] !== 'string' || !result.faces[id].trim()))))) throw new Error('faces 必须覆盖全部原始 speakerId，值为 candidateId 或 null');
  const candidates = Object.values(result.faces || {}).filter(id => id !== null);
  if (new Set(candidates).size !== candidates.length) throw new Error('同一个头像候选不能分配给多个说话人');
  return result.faces === undefined ? { speakers, summary } : { speakers, summary, faces: result.faces };
}
