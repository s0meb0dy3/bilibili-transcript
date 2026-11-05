import { fingerprint } from './semantic.js';

export const PROMPT_VERSION = 'identity-v5';
const SYSTEM_PROMPT = `根据转写内容和视频资料，推测每个说话人的身份标签。
资料包括：视频标题、简介、UP主公开信息、转写中的称呼和自我介绍，这些都仅供参考。
只输出 JSON：{"people":[{"speaker_id":"输入的ID","name":null,"evidence":[]}]}。
必须返回输入里的每一个 speaker_id，不能新增；unknown 返回 null。
name 可以是人名，也可以是职位（如主持人、嘉宾），或者“人名＋职位”；不要编造。evidence 要引用标题、简介或转写里的原文片段。
要结合转写中的称呼或自我介绍把身份和具体说话人对应起来，不能只按标题里名单的顺序猜。
UP主资料只是上传者，不能默认UP主就是发言人。
没有可靠依据就把 name 设为 null。`;

function checkAbort(signal) {
  if (signal?.aborted) throw new DOMException('已取消人物推断', 'AbortError');
}

function validName(name) {
  if (typeof name !== 'string' || name !== name.trim() || !name || name.length > 80) return false;
  // Allow a plain role (host/guest), a full name, or "name + role"; just keep it short text.
  const parts = name.split(/[ ·•.'’，,、\/\-]/u).filter(Boolean);
  return parts.length > 0 && parts.every(part => /^[\p{Script=Han}\p{Script=Latin}]+$/u.test(part));
}

function makeRequest(cues, metadata, speakerIds, model) {
  const data = {
    speaker_ids: speakerIds,
    metadata: Object.fromEntries(['title', 'description', 'desc', 'intro', 'tags', 'chapters']
      .filter(key => metadata[key] != null)
      .map(key => [key, JSON.stringify(metadata[key]).slice(0, 1000)])),
    cues: []
  };
  if (metadata.uploader) data.metadata.uploader = Object.fromEntries(
    ['name', 'bio', 'verification'].filter(key => typeof metadata.uploader[key] === 'string')
      .map(key => [key, metadata.uploader[key].slice(0, 600)])
  );
  const groups = speakerIds.map(id => cues.map((cue, index) => ({ ...cue, index }))
    .filter(cue => cue.speakerId === id));
  const selected = new Set();
  // Round-robin first/last passages leave room for every speaker, not just the first one.
  const queues = groups.map(group => {
    const opening = group.slice(0, 6);
    const ending = group.slice(-6).reverse();
    return opening.flatMap((cue, index) => [cue, ending[index]].filter(Boolean));
  });
  const add = cue => {
    if (!cue || selected.has(cue.index)) return;
    const sample = { speaker_id: cue.speakerId, text: cue.text.slice(0, 600), cue_index: cue.index };
    data.cues.push(sample);
    // Reserve enough space for instructions; bound the actual serialized model input.
    if (JSON.stringify(data).length > 16500) data.cues.pop();
    else selected.add(cue.index);
  };
  for (let index = 0; index < 12; index++) queues.forEach(queue => add(queue[index]));
  // Other speakers' naming/address contexts can identify a speaker without self-introduction.
  cues.forEach((cue, index) => {
    if (/我叫|我是|名字|请问|欢迎|老师|先生|女士|同学|教授|博士|你好|hello|my name|I'm|I am/iu.test(cue.text)) {
      [index - 1, index, index + 1].forEach(position => {
        if (cues[position]) add({ ...cues[position], index: position });
      });
    }
  });
  data.cues.sort((a, b) => a.cue_index - b.cue_index);
  return {
    model, thinking: { type: 'disabled' }, temperature: 0,
    response_format: { type: 'json_object' }, max_tokens: 4096,
    messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: JSON.stringify(data) }]
  };
}

function validate(response, speakerIds, sources, cueTexts) {
  const parsed = typeof response === 'string' ? JSON.parse(response) : response;
  const people = Object.fromEntries(speakerIds.map(id => [id, { id, name: null, evidence: [], inferred: true }]));
  const seen = new Set();
  for (const person of parsed?.people || []) {
    const id = String(person.speaker_id);
    if (!Object.hasOwn(people, id) || seen.has(id) || id === 'unknown') continue;
    seen.add(id);
    if (!validName(person.name)) continue;
    const evidence = [...new Set((Array.isArray(person.evidence) ? person.evidence : [])
      .filter(quote => typeof quote === 'string' && quote.trim() && sources.some(source => source.includes(quote))))];
    // A cue quote ties the name to this speaker; the full name may instead come from the
    // title/description (e.g. transcript says "姚院长", intro says "姚洋").
    const cueEvidence = evidence.filter(quote => cueTexts.some(text => text.includes(quote)));
    const surname = [...person.name.trim()][0];
    const roleOnly = /^(主持人|嘉宾|主讲|嘉宾主持|主持人嘉宾|旁白|解说|记者|嘉宾|听众|提问者)$/.test(person.name.trim());
    const named = roleOnly ||
      evidence.some(quote => quote.includes(person.name)) ||
      (surname && cueEvidence.some(quote => quote.includes(surname)));
    if (!named || !cueEvidence.length) continue;
    people[id] = { id, name: person.name, evidence, inferred: true };
  }
  return people;
}

// Transport and storage are injected, so this module runs in both Node and the extension.
export async function inferPeople({
  cues, metadata = {}, model = 'deepseek-flash', callModel,
  store = { get: async () => null, set: async () => {} }, signal
}) {
  checkAbort(signal);
  const normalized = cues.map(cue => ({
    speakerId: cue.speakerId == null || cue.speakerId === '' ? 'unknown' : String(cue.speakerId),
    text: String(cue.text ?? '')
  }));
  const speakerIds = [...new Set(normalized.map(cue => cue.speakerId))];
  if (!speakerIds.length) return {};
  const request = makeRequest(normalized, metadata, speakerIds, model);
  const key = `identity:${await fingerprint({ model, metadata, cues, request, promptVersion: PROMPT_VERSION })}`;
  checkAbort(signal);
  let answer = await store.get(key);
  checkAbort(signal);
  const sources = [metadata.title, metadata.description, metadata.desc, metadata.intro,
    metadata.uploader?.name, metadata.uploader?.bio, metadata.uploader?.verification,
    ...normalized.map(cue => cue.text)].filter(value => typeof value === 'string');
  if (answer) return validate(answer.response, speakerIds, sources, normalized.map(cue => cue.text));
  answer = await callModel(request, { signal });
  checkAbort(signal);
  const people = validate(answer.response, speakerIds, sources, normalized.map(cue => cue.text));
  await store.set(key, answer);
  checkAbort(signal);
  return people;
}
