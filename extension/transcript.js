const charCount = text => Array.from(text).length;

/** Bailian timestamps are already milliseconds. Words remain the original data. */
export function normalizeTranscript(raw) {
  if (!Array.isArray(raw?.transcripts)) throw new TypeError('transcripts must be an array');
  const sentences = raw.transcripts.flatMap(transcript => {
    if (!Array.isArray(transcript.sentences)) throw new TypeError('sentences must be an array');
    return transcript.sentences;
  });
  return sentences.map(sentence => {
    const { begin_time: startMs, end_time: endMs, text, speaker_id: speakerId, words } = sentence;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs < startMs) {
      throw new RangeError('Invalid sentence time range');
    }
    if (typeof text !== 'string') throw new TypeError('Sentence text must be a string');
    return {
      startMs, endMs, text,
      speakerId: speakerId == null || speakerId === '' ? 'unknown' : String(speakerId),
      words: words ?? []
    };
  }).sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
    .map((cue, index) => ({ id: String(index + 1), ...cue }));
}

function speakerTurns(cues) {
  const turns = [];
  for (const cue of cues) {
    if (!turns.length || turns.at(-1)[0].speakerId !== cue.speakerId) turns.push([]);
    turns.at(-1).push(cue);
  }
  return turns;
}

function panelParagraph(cues, number) {
  return {
    id: `paragraph-${number}`, cueIds: cues.map(cue => cue.id),
    startMs: cues[0].startMs, endMs: Math.max(...cues.map(cue => cue.endMs)),
    text: cues.map(cue => cue.text).join(''), speakerId: cues[0].speakerId,
    sourceRanges: cues.map(cue => ({ cueId: cue.id, start: 0, end: cue.text.length }))
  };
}

/** Whole ASR sentences are indivisible, including sentences over the target. */
export function paragraphize(cues, { targetChars = 250 } = {}) {
  if (!Number.isFinite(targetChars) || targetChars <= 0) throw new RangeError('targetChars must be positive');
  const paragraphs = [];
  for (const turn of speakerTurns(cues)) {
    let group = [];
    let count = 0;
    for (const cue of turn) {
      const size = charCount(cue.text);
      if (group.length && (count >= targetChars || Math.abs(count + size - targetChars) > Math.abs(count - targetChars))) {
        paragraphs.push(panelParagraph(group, paragraphs.length + 1));
        group = [];
        count = 0;
      }
      group.push(cue);
      count += size;
    }
    if (group.length) paragraphs.push(panelParagraph(group, paragraphs.length + 1));
  }
  return paragraphs;
}

