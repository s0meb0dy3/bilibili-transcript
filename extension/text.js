const SENTENCE_END = new Set(['。', '！', '？', '!', '?']);
const CLOSING_MARKS = new Set(['”', '’', '"', "'", '）', ')', '】', ']', '》', '」', '』']);

function isSentenceEnd(text, index) {
  const char = text[index];
  if (SENTENCE_END.has(char)) return true;
  // 不拆开数字、单词和网址中的句点。
  return char === '.' && (
    index + 1 === text.length || /\s/.test(text[index + 1]) ||
    CLOSING_MARKS.has(text[index + 1])
  );
}

// 返回 UTF-16 句子范围，保留原文和句尾空白。
export function sentenceRanges(text) {
  const ranges = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (!isSentenceEnd(text, index)) continue;
    let end = index + 1;
    while (end < text.length && (
      SENTENCE_END.has(text[end]) || text[end] === '.' ||
      CLOSING_MARKS.has(text[end])
    )) end += 1;
    // 句尾空白保留在原句。
    while (end < text.length && /\s/.test(text[end])) end += 1;
    ranges.push({ start, end });
    start = end;
    index = end - 1;
  }
  if (start < text.length) ranges.push({ start, end: text.length });
  return ranges;
}
