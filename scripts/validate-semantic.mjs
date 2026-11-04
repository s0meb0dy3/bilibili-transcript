import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { normalizeItems, validateModelParagraphs, contentSignature } from '../extension/semantic-validation.js';

const files = [];
for (const part of [1, 2, 3]) {
  const name = `BV1728bzzEwA-P${part}-ai-zh`;
  const raw = JSON.parse(await readFile(`fixtures/subtitles/${name}.json`, 'utf8'));
  const result = JSON.parse(await readFile(`fixtures/semantic/${name}.semantic.json`, 'utf8'));
  const items = normalizeItems(raw);
  const checked = validateModelParagraphs(result, items);
  assert.equal(contentSignature(items.map(item => item.text).join('')), contentSignature(result.paragraphs.map(p => p.text).join('')));
  assert.equal(result.paragraphs.length, checked.length);
  result.paragraphs.forEach((paragraph, index) => {
    for (const field of ['start_item', 'end_item', 'from', 'to', 'raw_text', 'text']) assert.equal(paragraph[field], checked[index][field]);
  });
  const lengths = result.paragraphs.map(p => Array.from(p.text).length).sort((a, b) => a - b);
  const row = {
    part, cues: items.length, paragraphs: checked.length,
    minChars: lengths[0], medianChars: lengths[Math.floor(lengths.length / 2)], maxChars: lengths.at(-1),
    fullCoverage: true, unchangedWords: true, timeMapping: true,
    review: result.review || [], stats: result.stats
  };
  files.push(row);
  console.log(`P${part}: ${items.length}条 → ${checked.length}段，最大${row.maxChars}字符，覆盖/原文/时间校验通过`);
}
await mkdir('artifacts', { recursive: true });
await writeFile('artifacts/semantic-validation.json', JSON.stringify({ model: 'deepseek-flash', files }, null, 2));
