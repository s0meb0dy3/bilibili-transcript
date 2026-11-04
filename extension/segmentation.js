/** Bump when sentence boundaries or paragraph grouping change. */
export const SEGMENTATION_VERSION = 'sentence-v1';

const SENTENCE_END = new Set(['。', '！', '？', '!', '?']);
const CLOSING_MARKS = new Set(['”', '’', '"', "'", '）', ')', '】', ']', '》', '」', '』']);

function isSentenceEnd(text, index) {
  const char = text[index];
  if (SENTENCE_END.has(char)) return true;
  // A dot inside a number, word or URL is not a reliable sentence boundary.
  return char === '.' && (
    index + 1 === text.length || /\s/.test(text[index + 1]) ||
    CLOSING_MARKS.has(text[index + 1])
  );
}

/**
 * Return indivisible sentence spans, including an unfinished final span.
 * Offsets are UTF-16 [start, end), matching String.prototype.slice.
 * Cues are deliberately joined before scanning: a cue is not a sentence.
 * No punctuation means no split, even across long pauses. Timing alone does
 * not establish a semantic sentence end, so we do not use pause candidates.
 */
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
    // Keep existing whitespace with its preceding sentence; never trim it.
    while (end < text.length && /\s/.test(text[end])) end += 1;
    ranges.push({ start, end });
    start = end;
    index = end - 1;
  }
  if (start < text.length) ranges.push({ start, end: text.length });
  return ranges;
}

/**
 * Group whole sentences near targetChars (Unicode code points, not bytes).
 * All source text is retained verbatim, without inserted spaces/punctuation.
 * sourceRanges use offsets within the original cue, with exclusive ends.
 * A boundary within one cue shares that cue's original timestamps; there is
 * no character-level timing data from which to invent a more precise time.
 */
export function segmentCues(cues, { targetChars = 200 } = {}) {
  if (!Number.isFinite(targetChars) || targetChars <= 0) {
    throw new RangeError('targetChars must be a positive finite number');
  }

  let offset = 0;
  const sources = cues.map((cue) => {
    const source = { cue, start: offset, end: offset + cue.text.length };
    offset = source.end;
    return source;
  });
  const text = cues.map((cue) => cue.text).join('');
  const spans = [];
  let current = null;
  for (const sentence of sentenceRanges(text)) {
    const length = Array.from(text.slice(sentence.start, sentence.end)).length;
    if (current && (
      current.length >= targetChars ||
      Math.abs(current.length + length - targetChars) >
        Math.abs(current.length - targetChars)
    )) {
      spans.push(current);
      current = null;
    }
    if (current) {
      current.end = sentence.end;
      current.length += length;
    } else {
      current = { ...sentence, length };
    }
  }
  if (current) spans.push(current);

  let sourceIndex = 0;
  return spans.map((span, index) => {
    while (sourceIndex < sources.length && sources[sourceIndex].end <= span.start) {
      sourceIndex += 1;
    }
    const sourceRanges = [];
    const cueIds = [];
    let startMs;
    let endMs = -Infinity;
    for (let i = sourceIndex; i < sources.length && sources[i].start < span.end; i += 1) {
      const source = sources[i];
      const start = Math.max(span.start, source.start) - source.start;
      const end = Math.min(span.end, source.end) - source.start;
      if (start === end) continue;
      sourceRanges.push({ cueId: source.cue.id, start, end });
      cueIds.push(source.cue.id);
      startMs ??= source.cue.startMs;
      endMs = Math.max(endMs, source.cue.endMs);
    }
    return {
      id: `paragraph-${index + 1}`,
      cueIds,
      startMs,
      endMs,
      text: text.slice(span.start, span.end),
      sourceRanges,
    };
  });
}
