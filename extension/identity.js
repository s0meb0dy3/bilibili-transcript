import { fingerprint } from './semantic.js';

export const PROMPT_VERSION = 'identity-v6';
// Keep one request below the model context; longer videos are split at sentence boundaries.
const CHUNK_CHARS = 100000;
const ROLE = /^(主持人|嘉宾|主讲|嘉宾主持|主持人嘉宾|旁白|解说|记者|听众|提问者|服务员|选手)$/;

function checkAbort(signal) {
  if (signal?.aborted) throw new DOMException('已取消人物推断', 'AbortError');
}

function validName(name) {
  if (typeof name !== 'string' || name !== name.trim() || !name || name.length > 60) return false;
  const parts = name.split(/[ ·•.'’，,、\/\-（）()【】]/u).filter(Boolean);
  return parts.length > 0 && parts.every(part => /^[\p{Script=Han}\p{Script=Latin}\p{N}]+$/u.test(part));
}

function metadataLines(metadata) {
  const lines = [];
  if (metadata.title) lines.push(`视频标题：${metadata.title}`);
  if (metadata.description || metadata.desc) lines.push(`视频简介：${metadata.description || metadata.desc}`);
  if (metadata.chapters?.length > 1) lines.push(`分P：${metadata.chapters.join(' / ')}`);
  if (metadata.uploader?.name) {
    const extra = [metadata.uploader.bio, metadata.uploader.verification].filter(Boolean).join('；');
    lines.push(`UP主：${metadata.uploader.name}${extra ? `（${extra}）` : ''}`);
  }
  return lines.map(line => line.slice(0, 1200)).join('\n');
}

function promptFor(metadata, speakerIds, transcript) {
  return `这是视频《${metadata.title || ''}》的完整转写，按说话人编号标注。
${metadataLines(metadata)}

请推断每个说话人的身份。优先使用资料或转写中出现的具体姓名或账号名；确实没有具体名称时，才填“主持人”“嘉宾”这类角色。不要编造。
只输出 JSON：{"people":[{"speaker_id":"0","name":""}]}，必须包含所有说话人：${speakerIds.join('、')}；完全无法判断填空字符串。

${transcript}`;
}

function makeRequest(metadata, speakerIds, transcript, model) {
  return {
    model, thinking: { type: 'disabled' }, temperature: 0,
    response_format: { type: 'json_object' }, max_tokens: 2000,
    messages: [{ role: 'user', content: promptFor(metadata, speakerIds, transcript) }]
  };
}

function parse(answer) {
  const data = answer?.response ?? answer;
  const parsed = typeof data === 'string' ? JSON.parse(data) : data;
  return Array.isArray(parsed?.people) ? parsed.people : [];
}

function grounded(name, sources) {
  const base = name.replace(/[（(].*$/, '').trim();
  if (ROLE.test(base)) return true;
  return sources.some(source => source.includes(base));
}

function validate(list, speakerIds, sources, speakerChars) {
  const people = Object.fromEntries(speakerIds.map(id => [id, { id, name: null, evidence: [], inferred: true }]));
  const weight = new Map();
  for (const person of list) {
    const id = String(person.speaker_id);
    if (!Object.hasOwn(people, id) || id === 'unknown') continue;
    const name = String(person.name ?? '').trim();
    if (!validName(name) || !grounded(name, sources)) continue;
    const rank = speakerChars.get(id) || 0;
    if (!weight.has(name) || weight.get(name).rank < rank) weight.set(name, { id, rank });
  }
  // One concrete name belongs to one speaker; roles may repeat.
  const usedNames = new Set();
  for (const [name, { id }] of [...weight.entries()].sort((a, b) => b[1].rank - a[1].rank)) {
    if (!ROLE.test(name) && usedNames.has(name)) continue;
    usedNames.add(name);
    people[id] = { id, name, evidence: [], inferred: true };
  }
  return people;
}

function chunksOf(cues) {
  const chunks = [];
  let current = [];
  let size = 0;
  for (const cue of cues) {
    if (current.length && size + cue.text.length > CHUNK_CHARS) {
      chunks.push(current); current = []; size = 0;
    }
    current.push(cue); size += cue.text.length;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

// Transport and storage are injected, so this module runs in both Node and the extension.
export async function inferPeople({
  cues, metadata = {}, model = 'deepseek-flash', callModel,
  store = { get: async () => null, set: async () => {} }, signal
}) {
  checkAbort(signal);
  const normalized = cues.map((cue, index) => ({
    index: index + 1,
    speakerId: cue.speakerId == null || cue.speakerId === '' ? 'unknown' : String(cue.speakerId),
    text: String(cue.text ?? '')
  }));
  const speakerIds = [...new Set(normalized.map(cue => cue.speakerId))];
  if (!speakerIds.length) return {};

  const speakerChars = new Map(speakerIds.map(id => [id, 0]));
  for (const cue of normalized) speakerChars.set(cue.speakerId, speakerChars.get(cue.speakerId) + cue.text.length);
  const sources = [metadata.title, metadata.description, metadata.desc, metadata.intro,
    metadata.uploader?.name, metadata.uploader?.bio, metadata.uploader?.verification,
    metadata.chapters].flat().filter(value => typeof value === 'string').concat(normalized.map(cue => cue.text));

  const chunks = chunksOf(normalized);
  const key = `identity:${await fingerprint({ model, metadata, cues, promptVersion: PROMPT_VERSION, chunks: chunks.length })}`;
  checkAbort(signal);
  const cached = await store.get(key);
  checkAbort(signal);

  let lists;
  if (cached?.responses) {
    lists = cached.responses.map(parse);
  } else {
    const responses = [];
    for (const chunk of chunks) {
      const transcript = chunk.map(cue => `[${cue.index}] 说话人${cue.speakerId}：${cue.text}`).join('\n');
      responses.push(await callModel(makeRequest(metadata, speakerIds, transcript, model), { signal }));
      checkAbort(signal);
    }
    await store.set(key, { responses });
    lists = responses.map(parse);
  }
  checkAbort(signal);
  return validate(lists.flat(), speakerIds, sources, speakerChars);
}
