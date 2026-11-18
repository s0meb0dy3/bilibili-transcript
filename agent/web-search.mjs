export function createWebSearch(apiKey, fetchImpl = fetch) {
  if (!apiKey) return undefined;
  return async (query, signal) => {
    const response = await fetchImpl('https://api.deepseek.com/v1/tools/search', {
      method: 'POST', signal, redirect: 'error',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query: query.trim(), count: 5, need_content: false })
    });
    if (!response.ok) throw new Error('联网搜索失败，可依据已有资料继续判断');
    const { results = [] } = await response.json();
    return results.slice(0, 5).map(({ title, url, summary, snippet }) => ({ title, url, summary: summary || snippet || '' }));
  };
}
