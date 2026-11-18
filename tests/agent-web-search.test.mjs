import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebSearch } from '../agent/web-search.mjs';

test('联网搜索调用DeepSeek Search API，只返回标题URL摘要', async () => {
  const signal = new AbortController().signal;
  const item = { title: '节目', url: 'https://example.com', summary: '嘉宾', content: '不返回' };
  const search = createWebSearch('test-key', async (url, options) => {
    assert.equal(url, 'https://api.deepseek.com/v1/tools/search');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    assert.equal(options.signal, signal);
    assert.deepEqual(JSON.parse(options.body), { query: '节目 嘉宾', count: 5, need_content: false });
    return Response.json({ results: Array(6).fill(item) });
  });
  assert.deepEqual(await search('节目 嘉宾', signal), Array(5).fill({ title: item.title, url: item.url, summary: item.summary }));
  assert.equal(createWebSearch(), undefined);
});
