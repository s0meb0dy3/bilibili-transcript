// Only these editorial marks may change. Operators and other symbols stay literal.
const EDITORIAL = new Set(Array.from('，。！？；：、,.!?;:’‘“”\'"「」『』《》〈〉（）()【】[]〔〕{}—–…'));
const NUMBER = /\p{N}/u;

export class ValidationError extends Error {
  constructor(issues, paragraphs) {
    super(issues.map(({ message }) => message).join('; '));
    this.name = 'ValidationError';
    this.issues = issues;
    if (paragraphs !== undefined) this.paragraphs = paragraphs;
  }
}

function issue(index, code, message) {
  return { index, code, message };
}

function fail(code, message) {
  throw new ValidationError([issue(null, code, message)]);
}

export function normalizeItems(raw) {
  const entries = Array.isArray(raw) ? raw : raw?.body;
  if (!Array.isArray(entries)) fail('items', '字幕必须是数组或包含 body 数组的对象');
  let previousFrom = -Infinity;
  return entries.map((entry, index) => {
    if (!entry || typeof entry.content !== 'string'
      || !Number.isFinite(entry.from) || !Number.isFinite(entry.to)
      || entry.from < 0 || entry.to < entry.from || entry.from < previousFrom) {
      fail('items', `第 ${index + 1} 条字幕的正文或时间无效`);
    }
    previousFrom = entry.from;
    return { id: index + 1, text: entry.content, from: entry.from, to: entry.to };
  });
}

function signatureData(text) {
  const protectedAt = new Set();
  // Exclude sentence punctuation following a URL, but retain balanced URL brackets.
  const tokens = /\b(?:(?:[a-z][a-z\d+.-]*:\/\/|www\.)[^\s\u3000-\u303f\uff00-\uffef<>“”‘’「」『』]+|[\w.!#$%&'*+/=?^`{|}~-]+@[a-z\d-]+(?:\.[a-z\d-]+)+|[a-z\d-]+(?:\.[a-z\d-]+)*\.[a-z]{2,}(?:[/?#][^\s\u3000-\u303f\uff00-\uffef<>“”‘’「」『』]*)?)/giu;
  for (const match of text.matchAll(tokens)) {
    let token = match[0].replace(/[.,!?;:'"]+$/u, '');
    for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
      while (token.endsWith(close)
        && token.split(close).length > token.split(open).length) token = token.slice(0, -1);
    }
    for (let offset = match.index; offset < match.index + token.length; offset += 1) protectedAt.add(offset);
  }

  const chars = Array.from(text);
  const nextVisible = [];
  let next = '';
  for (let index = chars.length - 1; index >= 0; index -= 1) {
    nextVisible[index] = next;
    if (!/\s/u.test(chars[index])) next = chars[index];
  }
  const units = [];
  let offset = 0;
  let before = '';
  chars.forEach((char, index) => {
    const after = nextVisible[index];
    const numericMark = (char === '.' && NUMBER.test(after))
      || (',，．:：—–…'.includes(char) && NUMBER.test(before) && NUMBER.test(after));
    const letterRange = '—–'.includes(char) && /[a-z\d]/i.test(before) && /[a-z\d]/i.test(after);
    const apostrophe = (char === "'" || char === '’') && /[a-z]/i.test(before) && /[a-z]/i.test(after);
    if (!/\s/u.test(char)) {
      if (!EDITORIAL.has(char) || protectedAt.has(offset) || numericMark || letterRange || apostrophe) {
        units.push({ char, start: offset, end: offset + char.length });
      }
      before = char;
    }
    offset += char.length;
  });
  return { signature: units.map(({ char }) => char).join(''), units };
}

export function contentSignature(text) {
  return signatureData(text).signature;
}

function sourceData(items) {
  const text = items.map((item) => item.text).join('');
  const data = signatureData(text);
  const boundaries = [0];
  let textOffset = 0;
  let unitIndex = 0;
  let signatureOffset = 0;
  for (const item of items) {
    textOffset += item.text.length;
    while (unitIndex < data.units.length && data.units[unitIndex].start < textOffset) {
      signatureOffset += data.units[unitIndex].char.length;
      unitIndex += 1;
    }
    boundaries.push(signatureOffset);
  }
  return { ...data, boundaries };
}

function realBody(text) {
  return /[^\p{P}\s]/u.test(text);
}

function paragraphsFor(rows, starts, items) {
  return rows.map((row, index) => {
    const start = starts[index];
    const end = starts[index + 1] ?? items.length;
    const covered = items.slice(start, end);
    return {
      start_item: items[start].id,
      end_item: items[end - 1].id,
      from: items[start].from,
      to: Math.max(...covered.map((item) => item.to)),
      raw_text: covered.map((item) => item.text).join(''),
      text: row.text,
    };
  });
}

function alignedStarts(signatures, source) {
  let offset = 0;
  const starts = [0];
  let ambiguous = false;
  for (let index = 0; index < signatures.length; index += 1) {
    const signature = signatures[index];
    if (!signature || !source.signature.startsWith(signature, offset)) return { starts: null };
    offset += signature.length;
    if (index === signatures.length - 1) break;
    const candidates = [];
    for (let boundary = 1; boundary < source.boundaries.length - 1; boundary += 1) {
      if (source.boundaries[boundary] === offset) candidates.push(boundary);
    }
    if (!candidates.length) return { starts: null };
    if (candidates.length > 1) ambiguous = true;
    starts.push(candidates[0]);
  }
  if (offset !== source.signature.length) return { starts: null };
  return { starts, ambiguous };
}

export function validateModelParagraphs(response, items, { maxChars = 350 } = {}) {
  if (!Number.isInteger(maxChars) || maxChars < 1) fail('structure', 'maxChars 必须是正整数');
  if (!response || !Array.isArray(response.paragraphs)) fail('structure', '模型必须返回 paragraphs 数组');
  const rows = response.paragraphs;
  if (!items.length && !rows.length) return [];
  if (!items.length || !rows.length) fail('coverage', '段落必须完整覆盖字幕');
  const itemIndices = new Map(items.map((item, index) => [item.id, index]));
  let previous = -Infinity;
  for (const row of rows) {
    if (!row || !Number.isInteger(row.start_item) || !itemIndices.has(row.start_item)
      || row.start_item <= previous || typeof row.text !== 'string') {
      fail('structure', '段落起始编号必须合法且严格递增，正文必须是字符串');
    }
    previous = row.start_item;
  }

  const source = sourceData(items);
  const signatures = rows.map((row) => contentSignature(row.text));
  let starts = rows.map((row) => itemIndices.get(row.start_item));
  const declaredIssues = [];
  if (starts[0] === 0) {
    rows.forEach((row, index) => {
      const end = starts[index + 1] ?? items.length;
      const expected = source.signature.slice(source.boundaries[starts[index]], source.boundaries[end]);
      if (signatures[index] !== expected) declaredIssues.push(issue(index, 'content', '正文与声明的字幕范围不一致'));
    });
  }
  if (starts[0] !== 0 || declaredIssues.length) {
    const aligned = alignedStarts(signatures, source);
    if (aligned.ambiguous) fail('ambiguous', '正文存在多个可行的字幕边界，无法修复编号');
    if (aligned.starts) starts = aligned.starts;
    else if (starts[0] !== 0) fail('coverage', '正文无法按顺序完整对齐字幕');
    else {
      const paragraphs = paragraphsFor(rows, starts, items);
      throw new ValidationError([...declaredIssues, ...paragraphIssues(rows, maxChars)], paragraphs);
    }
  }
  const paragraphs = paragraphsFor(rows, starts, items);
  const issues = paragraphIssues(rows, maxChars);
  if (issues.length) throw new ValidationError(issues, paragraphs);
  return paragraphs;
}

function paragraphIssues(rows, maxChars) {
  const issues = [];
  rows.forEach((row, index) => {
    if (!realBody(row.text)) issues.push(issue(index, 'content', '每段必须包含非标点、非空白的正文'));
    if (Array.from(row.text).length > maxChars) issues.push(issue(index, 'length', `段落超过 ${maxChars} 个字符`));
  });
  return issues;
}

export function alignDisplayFragments(text, items) {
  const source = sourceData(items);
  const display = signatureData(text);
  if (display.signature !== source.signature) fail('content', '显示正文与字幕内容不一致');
  const fragments = [];
  let signatureOffset = 0;
  let unitIndex = 0;
  let displayOffset = 0;
  for (let index = 0; index < items.length; index += 1) {
    const boundary = source.boundaries[index + 1];
    while (unitIndex < display.units.length && signatureOffset < boundary) {
      signatureOffset += display.units[unitIndex].char.length;
      unitIndex += 1;
    }
    // Attach punctuation after a cue to that cue; keep the entire original display string.
    const end = index === items.length - 1 ? text.length
      : boundary === source.boundaries[index] ? displayOffset
        : (display.units[unitIndex]?.start ?? text.length);
    fragments.push({ cueId: String(items[index].id), text: text.slice(displayOffset, end) });
    displayOffset = end;
  }
  if (!items.length && text.length) fail('coverage', '无字幕可映射显示正文');
  return fragments;
}
