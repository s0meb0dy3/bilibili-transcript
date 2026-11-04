import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeItems, validateModelParagraphs, contentSignature, alignDisplayFragments, ValidationError,
} from '../extension/semantic-validation.js';

const items = (...texts) => normalizeItems(texts.map((content, index) => ({ content, from: index, to: index + 1 })));
const response = (...rows) => ({ paragraphs: rows.map(([start_item, text]) => ({ start_item, text })) });
function rejects(run, code, index) {
  assert.throws(run, (error) => {
    assert.ok(error instanceof ValidationError);
    assert.ok(error.issues.some((entry) => entry.code === code && entry.index === index), JSON.stringify(error.issues));
    assert.ok(error.issues.every((entry) => typeof entry.message === 'string'));
    return true;
  });
}

test('normalize preserves exact text, numbers sequentially and permits overlapping intervals', () => {
  assert.deepEqual(normalizeItems([
    { id: 99, content: ' 甲\n', from: 0, to: 5 }, { content: '', from: 1, to: 2 },
    { content: '。', from: 1, to: 3 },
  ]), [
    { id: 1, text: ' 甲\n', from: 0, to: 5 }, { id: 2, text: '', from: 1, to: 2 },
    { id: 3, text: '。', from: 1, to: 3 },
  ]);
  assert.deepEqual(normalizeItems([]), []);
});

test('normalize accepts the complete Bilibili subtitle body object', () => {
  assert.deepEqual(normalizeItems({ body: [{ content: '原文', from: 0, to: 1 }], extra: true }), items('原文'));
});

test('local windows and retry subsets preserve their original item IDs', () => {
  const input = items('甲', '乙', '丙', '丁').map((item, index) => ({ ...item, id: 475 + index }));
  const result = validateModelParagraphs(response([475, '甲乙。'], [477, '丙丁。']), input);
  assert.deepEqual(result.map(({ start_item, end_item }) => [start_item, end_item]), [[475, 476], [477, 478]]);
  const repaired = validateModelParagraphs(response([476, '甲乙。'], [477, '丙丁。']), input);
  assert.deepEqual(repaired, result);
  const retried = validateModelParagraphs(response([477, '丙丁。']), input.slice(2));
  assert.deepEqual(retried, [result[1]]);
  rejects(() => validateModelParagraphs(response([1, '甲乙丙丁']), input), 'structure', null);
  assert.deepEqual(alignDisplayFragments('丙，丁。', input.slice(2)), [
    { cueId: '477', text: '丙，' }, { cueId: '478', text: '丁。' },
  ]);
});

test('normalize rejects invalid content and times, including backwards starts', () => {
  for (const raw of [null, {}, [{ content: 1, from: 0, to: 1 }],
    [{ content: '甲', from: '0', to: 1 }], [{ content: '甲', from: NaN, to: 1 }],
    [{ content: '甲', from: 0, to: Infinity }], [{ content: '甲', from: -1, to: 1 }],
    [{ content: '甲', from: 2, to: 1 }],
    [{ content: '甲', from: 1, to: 2 }, { content: '乙', from: 0, to: 3 }]]) {
    rejects(() => normalizeItems(raw), 'items', null);
  }
});

test('safe punctuation, quotes, brackets and whitespace may change without changing words', () => {
  const input = items('他说《你好》', '世界……再见');
  const result = validateModelParagraphs(response([1, '他说：“你好”，世界！再见。']), input);
  assert.deepEqual(result, [{ start_item: 1, end_item: 2, from: 0, to: 2,
    raw_text: '他说《你好》世界……再见', text: '他说：“你好”，世界！再见。' }]);
  assert.equal(contentSignature(' 甲（乙）——丙……。\n'), '甲乙丙');
});

test('numbers, decimal points, percentages, arithmetic signs, ranges and dates are protected', () => {
  for (const [original, changed] of [
    ['增长1.5%', '增长15%'], ['增长1.5%', '增长1.5'], ['增长1.5%', '增长1，5%'],
    ['-2 + 3 = 1', '2 + 3 = 1'], ['+2', '2'], ['2/3', '23'], ['2=2', '22'],
    ['2026-11-03', '2026/11/03'], ['2026/11/03', '20261103'],
    ['1–5', '15'], ['1 — 5', '1，5'], ['A–Z', 'AZ'], ['.5%', '5%'],
    ['1,000', '1000'], ['12:30', '1230'], ['阿·里', '阿里'],
    ["don't", 'dont'],
  ]) rejects(() => validateModelParagraphs(response([1, changed]), items(original)), 'content', 0);
  assert.equal(validateModelParagraphs(response([1, '增长 1.5%，很好！']), items('增长1.5%很好'))[0].text,
    '增长 1.5%，很好！');
});

test('URL and email punctuation remains literal; external sentence punctuation can change', () => {
  const url = 'https://example.com/a-b?q=1.5%25&next=/a#part';
  const mail = 'first.last+tag@example.com';
  const input = items(`访问${url}`, `邮箱${mail}`);
  validateModelParagraphs(response([1, `访问${url}，邮箱${mail}。`]), input);
  for (const changed of [url.replace('.', ''), url.replace('?', ''), url.replace('-', ''),
    url.replace('=', ''), url.replace('/', ''), url.replace('#', '')]) {
    rejects(() => validateModelParagraphs(response([1, changed]), items(url)), 'content', 0);
  }
  rejects(() => validateModelParagraphs(response([1, mail.replace('.', '')]), items(mail)), 'content', 0);
  assert.equal(contentSignature(`(${url}).`), url);
  assert.equal(contentSignature('https://example.com/a(b)'), 'https://example.com/a(b)');
  assert.equal(contentSignature('访问example.com/a?x=1。'), '访问example.com/a?x=1');
  rejects(() => validateModelParagraphs(response([1, 'examplecom/a?x=1']), items('example.com/a?x=1')), 'content', 0);
});

test('correct declared boundaries give precise paragraph errors and preserve parsed paragraphs', () => {
  const input = items('第一句', '第二句', '第三句');
  for (const wrong of ['第句。', '第二词。', '第二句第二句。']) {
    assert.throws(() => validateModelParagraphs(response([1, '第一句。'], [2, wrong], [3, '第三句。']), input), (error) => {
      assert.deepEqual(error.issues.map(({ index, code }) => ({ index, code })), [{ index: 1, code: 'content' }]);
      assert.equal(error.paragraphs[1].raw_text, '第二句');
      assert.equal(error.paragraphs[2].start_item, 3);
      return true;
    });
  }
});

test('every original item must be covered once, in order, and paragraphs cannot split an item', () => {
  const input = items('甲乙', '丙丁', '戊己');
  for (const rows of [response([1, '甲乙'], [2, '戊己']), response([1, '甲乙丙丁'], [3, '丙丁戊己']),
    response([1, '丙丁'], [2, '甲乙戊己']), response([1, '甲'], [2, '乙丙丁戊己'])]) {
    assert.throws(() => validateModelParagraphs(rows, input), ValidationError);
  }
  rejects(() => validateModelParagraphs(response([2, '丙丁戊己']), input), 'coverage', null);
});

test('an entirely matching response can uniquely repair shifted starts', () => {
  const input = items('甲', '乙', '丙', '丁');
  const result = validateModelParagraphs(response([2, '甲乙，'], [3, '丙丁。']), input);
  assert.deepEqual(result.map(({ start_item, end_item }) => [start_item, end_item]), [[1, 2], [3, 4]]);
  const oneWrong = validateModelParagraphs(response([1, '甲乙。'], [2, '丙丁。']), input);
  assert.deepEqual(oneWrong.map(({ start_item }) => start_item), [1, 3]);
});

test('repair refuses ambiguous boundaries created by empty or punctuation-only items', () => {
  for (const middle of ['', '。', ' \n《》']) {
    const input = items('甲', middle, '乙', '丙');
    rejects(() => validateModelParagraphs(response([2, '甲。'], [4, '乙丙。']), input), 'ambiguous', null);
    // Explicit, correct numbering already determines ownership of the empty item.
    assert.equal(validateModelParagraphs(response([1, '甲。'], [3, '乙丙。']), input)[0].end_item, 2);
  }
});

test('invalid structure and numbering use a global issue', () => {
  const input = items('甲', '乙');
  for (const value of [null, {}, { paragraphs: {} }, response([0, '甲乙']), response([3, '甲乙']),
    response([1.5, '甲乙']), response(['1', '甲乙']), response([1, '甲'], [1, '乙']),
    response([2, '甲'], [1, '乙']), response([1, 123]), { paragraphs: [null] }]) {
    rejects(() => validateModelParagraphs(value, input), 'structure', null);
  }
  rejects(() => validateModelParagraphs(response(), input), 'coverage', null);
  assert.deepEqual(validateModelParagraphs(response(), []), []);
});

test('maxChars counts Unicode code points including punctuation and retains normalized results', () => {
  const input = items('😀'.repeat(350));
  assert.equal(validateModelParagraphs(response([1, '😀'.repeat(350)]), input).length, 1);
  assert.throws(() => validateModelParagraphs(response([1, `${'😀'.repeat(350)}。`]), input), (error) => {
    assert.deepEqual(error.issues.map(({ index, code }) => ({ index, code })), [{ index: 0, code: 'length' }]);
    assert.equal(error.paragraphs[0].end_item, 1);
    return true;
  });
  rejects(() => validateModelParagraphs(response([1, '甲，乙。']), items('甲乙'), { maxChars: 3 }), 'length', 0);
  assert.equal(validateModelParagraphs(response([1, '甲，乙。']), items('甲乙'), { maxChars: 4 }).length, 1);
});

test('paragraphs with only punctuation or whitespace are rejected with their paragraph index', () => {
  for (const text of ['', ' \n', '《》。']) {
    rejects(() => validateModelParagraphs(response([1, text]), items(text)), 'content', 0);
  }
});

test('display fragments preserve all inserted Chinese punctuation and item cue identities', () => {
  const input = items('你好', '世界', '再见');
  const text = '“你好”，世界！再见。';
  const fragments = alignDisplayFragments(text, input);
  assert.deepEqual(fragments, [
    { cueId: '1', text: '“你好”，' }, { cueId: '2', text: '世界！' }, { cueId: '3', text: '再见。' },
  ]);
  assert.equal(fragments.map((fragment) => fragment.text).join(''), text);
  const empty = alignDisplayFragments('甲，乙。', items('甲', '', '。', '乙'));
  assert.deepEqual(empty.map(({ cueId }) => cueId), ['1', '2', '3', '4']);
  assert.equal(empty.map(({ text }) => text).join(''), '甲，乙。');
  assert.deepEqual(alignDisplayFragments('', []), []);
});

test('display fragments protect words and special tokens, including tokens split across items', () => {
  const input = items('增长1.', '5%', '😀结束');
  const text = '增长 1.5%，😀结束！';
  assert.equal(alignDisplayFragments(text, input).map(({ text }) => text).join(''), text);
  rejects(() => alignDisplayFragments('增长15%，😀结束！', input), 'content', null);
  rejects(() => alignDisplayFragments('增长1.5%，结束！', input), 'content', null);
  rejects(() => alignDisplayFragments('甲', []), 'content', null);
});
