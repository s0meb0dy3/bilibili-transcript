const ROLE = /^(主持人|嘉宾|主讲|嘉宾主持|主持人嘉宾|旁白|解说|记者|听众|服务员|选手)$/;
const AVATAR_SIZE = 128;
const MAX_FRAMES = 40;

function baseName(name) {
  return String(name ?? '').split(/[（(]/)[0].trim();
}

function normalizeName(name) {
  const value = baseName(name).replace(/\s+/g, '');
  return ['不确定', 'unknown', '未知', '不认识'].includes(value) ? '' : value;
}

function headHeight(person) {
  return (person.box.y2 - person.box.y1) / 1000;
}

function insideFrame(person) {
  return person.box.x1 >= 2 && person.box.y1 >= 2 && person.box.x2 <= 998 && person.box.y2 <= 998;
}

function overlap(a, b) {
  const x1 = Math.max(a.x1, b.x1);
  const y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2);
  const y2 = Math.min(a.y2, b.y2);
  if (x2 <= x1 || y2 <= y1) return 0;
  const area = (a.x2 - a.x1) * (a.y2 - a.y1);
  return area > 0 ? ((x2 - x1) * (y2 - y1)) / area : 0;
}

// 按说话人回合取样，优先较长发言。
export function candidateTimes(cues, { maxTurns = 2, perTurn = 2 } = {}) {
  const turns = [];
  for (const cue of cues) {
    const last = turns.at(-1);
    if (last && last.speakerId === cue.speakerId) last.endMs = cue.endMs;
    else turns.push({ speakerId: cue.speakerId, startMs: cue.startMs, endMs: cue.endMs });
  }
  const groups = new Map();
  for (const turn of turns) {
    const list = groups.get(turn.speakerId) || [];
    list.push(turn);
    groups.set(turn.speakerId, list);
  }
  const result = [];
  for (const [speakerId, list] of groups) {
    const longest = [...list].sort((a, b) => (b.endMs - b.startMs) - (a.endMs - a.startMs)).slice(0, maxTurns);
    for (const turn of longest) {
      const span = Math.max(1, turn.endMs - turn.startMs);
      for (let index = 1; index <= perTurn; index++) {
        result.push({ speakerId, timeMs: Math.round(turn.startMs + span * (index / (perTurn + 1))) });
      }
    }
  }
  return result.sort((a, b) => a.timeMs - b.timeMs).slice(0, MAX_FRAMES);
}

// 兼容模型返回的框格式，坐标约定为 0～1000。
export function parseBox(raw) {
  if (raw == null) return null;
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    if (raw.box) return parseBox(raw.box);
    if (raw.bbox_2d) return parseBox(raw.bbox_2d);
    if (raw.box_2d) {
      const [y1, x1, y2, x2] = raw.box_2d.map(Number);
      return validBox(x1, y1, x2, y2);
    }
    if ('x1' in raw) return validBox(raw.x1, raw.y1, raw.x2, raw.y2);
    return null;
  }
  if (Array.isArray(raw)) {
    const [a, b, c, d] = raw.map(Number);
    return validBox(a, b, c, d);
  }
  const text = String(raw);
  const numbers = text.match(/\d+(?:\.\d+)?/g)?.map(Number);
  if (!numbers || numbers.length < 4) return null;
  return validBox(numbers[0], numbers[1], numbers[2], numbers[3]);
}

function validBox(x1, y1, x2, y2) {
  if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
  if (x2 <= x1 || y2 <= y1) return null;
  return { x1, y1, x2, y2 };
}

// 解析人物列表，允许模型携带代码围栏。
export function parsePeople(text) {
  if (Array.isArray(text)) return normalizePeople(text);
  const source = String(text ?? '');
  const array = source.match(/\[[\s\S]*\]/)?.[0];
  const object = source.match(/\{[\s\S]*\}/)?.[0];
  for (const candidate of [array, object]) {
    if (!candidate) continue;
    try {
      const value = JSON.parse(candidate);
      if (Array.isArray(value)) return normalizePeople(value);
      if (Array.isArray(value.people)) return normalizePeople(value.people);
    } catch { /* 尝试另一种结构 */ }
  }
  return [];
}

function normalizePeople(list) {
  return list.map(item => {
    const box = parseBox(item?.box ?? item?.bbox_2d ?? item?.box_2d ?? item);
    if (!box) return null;
    return { box, name: String(item?.name ?? item?.label ?? '').trim(), position: String(item?.position ?? '') };
  }).filter(Boolean);
}

export function visionPrompt({ title = '', description = '', uploader = '', nearbyText = '', candidates = [] } = {}) {
  return `分析这一帧视频画面。视频标题：${title}；简介：${description || '无'}；UP主：${uploader || '无'}。
${nearbyText ? `画面附近的台词：\n${nearbyText}\n` : ''}候选人物：${candidates.length ? candidates.join('、') : '无'}。
请列出画面中所有清晰可见的人物头部（只含头发和脸，不含身体），给出边界框 <box>(x1,y1),(x2,y2)</box>（归一化 0-1000）。
如果能确认是谁，从候选人物里选并填写 name；看不清或无法确认必须填“不确定”，禁止猜测或按名单顺序推断。
只输出 JSON 数组：[{"box":"<box>(x1,y1),(x2,y2)</box>","name":"","position":"左/中/右"}]`;
}

/**
 * frames: [{ speakerId, timeMs, people: [{ box, name }] }]
 * people: { [speakerId]: { name } }
 * Returns { [speakerId]: { timeMs, box, mode } | null }
 */
export function chooseAvatars(frames, people, { minNamedHead = 0.04, minSoloHead = 0.15 } = {}) {
  const result = {};
  const used = [];
  const knownNames = new Set(Object.values(people).map(item => normalizeName(item?.name)).filter(Boolean));
  for (const [speakerId, person] of Object.entries(people)) {
    const target = normalizeName(person?.name);
    const roleLabel = ROLE.test(baseName(person?.name));
    const usable = target && !roleLabel ? target : '';
    const named = [];
    const solo = [];
    for (const frame of frames) {
      const visible = (frame.people || []).filter(insideFrame);
      for (const candidate of visible) {
        if (!candidate.box) continue;
        if (usable && normalizeName(candidate.name) === usable && headHeight(candidate) >= minNamedHead) {
          named.push({ frame, person: candidate, score: headHeight(candidate) });
        }
      }
      if (!roleLabel && frame.speakerId === speakerId && visible.length === 1 && headHeight(visible[0]) >= minSoloHead) {
        const detected = normalizeName(visible[0].name);
        // 若认出的是其他说话人，拒绝把反应镜头当成头像。
        const otherSpeaker = detected && detected !== target && knownNames.has(detected);
        if (!otherSpeaker) solo.push({ frame, person: visible[0], score: headHeight(visible[0]) });
      }
    }
    const pick = [...named, ...solo].sort((a, b) => b.score - a.score)
      .find(item => !used.some(entry => entry.timeMs === item.frame.timeMs && overlap(entry.box, item.person.box) > 0.6));
    if (!pick) { result[speakerId] = null; continue; }
    used.push({ timeMs: pick.frame.timeMs, box: pick.person.box });
    result[speakerId] = { timeMs: pick.frame.timeMs, box: pick.person.box, mode: named.length ? 'name' : 'solo' };
  }
  return result;
}

// 无可靠照片时，生成彩色文字或数字头像。
export function initialAvatar(label, seed = label) {
  const colors = ['#5b7cfa', '#7a6ff0', '#e0699a', '#e08b4f', '#4fa97b', '#4f9fd0', '#b06fd0'];
  let hash = 0;
  for (const char of String(seed ?? '')) hash = (hash * 31 + char.codePointAt(0)) % 997;
  const numeric = Number(seed);
  const color = colors[(Number.isInteger(numeric) ? numeric : hash) % colors.length];
  const text = String(label ?? '').trim() || '?';
  const fontSize = text.length >= 3 ? 64 : text.length === 2 ? 88 : 112;
  const center = AVATAR_SIZE / 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${AVATAR_SIZE}" height="${AVATAR_SIZE}"><circle cx="${center}" cy="${center}" r="${center}" fill="${color}"/><text x="${center}" y="${center}" dy="0.35em" text-anchor="middle" font-family="PingFang SC,sans-serif" font-size="${fontSize}" fill="#ffffff">${escapeXml(text)}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function escapeXml(text) {
  return text.replace(/[<>&"']/g, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char]);
}

// 裁成方形图片，由界面以圆形展示。
export async function cropAvatar(dataUrl, box, { padding = 1.6, size = AVATAR_SIZE, portrait = false } = {}) {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const width = bitmap.width;
  const height = bitmap.height;
  const x1 = (box.x1 / 1000) * width;
  const y1 = (box.y1 / 1000) * height;
  const x2 = (box.x2 / 1000) * width;
  const y2 = (box.y2 / 1000) * height;
  const centerX = (x1 + x2) / 2;
  const centerY = (y1 + y2) / 2 + 0.03 * (y2 - y1);
  const side = Math.max(x2 - x1, y2 - y1) * (portrait ? 1.18 : padding);
  const left = Math.max(0, Math.min(width - side, centerX - side / 2));
  const top = Math.max(0, Math.min(height - side, centerY - side / 2));
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  canvas.getContext('2d').drawImage(bitmap, left, top, side, side, 0, 0, size, size);
  return canvas.toDataURL('image/jpeg', 0.85);
}

export function concreteName(name) {
  const base = baseName(name);
  return base && !ROLE.test(base) ? base : '';
}

export { AVATAR_SIZE };
