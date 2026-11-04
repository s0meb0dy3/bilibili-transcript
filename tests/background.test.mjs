import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
function background({ status = 200, finish = 'stop' } = {}) {
  const secret = 'private-test-value';
  let listener;
  let sent;
  let timeout;
  let options = 0;
  const listeners = {};
  const setupCalls = [];
  const event = name => ({ addListener: callback => { listeners[name] = callback; } });
  const scope = {
    chrome: {
      runtime: {
        id: 'our-extension', onMessage: { addListener: callback => { listener = callback; } },
        onInstalled: event('installed'), onStartup: event('startup'),
        openOptionsPage: async () => { options++; }
      },
      sidePanel: { setPanelBehavior: async value => { setupCalls.push({ action: 'behavior', value }); } },
      contextMenus: {
        removeAll: async () => { setupCalls.push({ action: 'removeAll' }); },
        create: value => { setupCalls.push({ action: 'create', value }); },
        onClicked: event('menu')
      },
      storage: { local: { get: async () => ({ deepseekConfig: { apiKey: secret, model: 'deepseek-flash' } }) } }
    },
    fetch: async (url, init) => {
      sent = { url, init };
      return { ok: status === 200, status, json: async () => ({ choices: [{ finish_reason: finish, message: { content: '{"paragraphs":[]}' } }], usage: { total_tokens: 9 } }) };
    },
    AbortController, setTimeout: (_fn, milliseconds) => { timeout = milliseconds; return 1; }, clearTimeout: () => {}
  };
  vm.runInNewContext(source, scope);
  return {
    async request(message, id = 'our-extension') {
      let resolve;
      const result = new Promise(done => { resolve = done; });
      const accepted = listener(message, { id }, resolve);
      if (!accepted) return { accepted: false };
      return result;
    },
    async emit(name, ...args) {
      assert.equal(typeof listeners[name], 'function', `${name} listener should be registered`);
      await listeners[name](...args);
    },
    inspect: () => ({ sent, timeout, options, secret, setupCalls })
  };
}

test('side panel setup runs only on installation and startup with one action settings menu', async () => {
  const worker = background();
  assert.deepEqual(worker.inspect().setupCalls, []);
  const expected = [
    { action: 'behavior', value: { openPanelOnActionClick: true } },
    { action: 'removeAll' },
    { action: 'create', value: { id: 'settings', title: '设置', contexts: ['action'] } }
  ];
  await worker.emit('installed');
  assert.deepEqual(JSON.parse(JSON.stringify(worker.inspect().setupCalls)), expected);
  await worker.emit('startup');
  assert.deepEqual(JSON.parse(JSON.stringify(worker.inspect().setupCalls)), [...expected, ...expected]);
  assert.equal(worker.inspect().sent, undefined);
});

test('only the settings action menu opens options and runtime openOptions still works', async () => {
  const worker = background();
  await worker.emit('menu', { menuItemId: 'unrelated' });
  assert.equal(worker.inspect().options, 0);
  await worker.emit('menu', { menuItemId: 'settings' });
  assert.equal(worker.inspect().options, 1);
  const response = await worker.request({ action: 'openOptions' });
  assert.equal(response.ok, true);
  assert.equal(worker.inspect().options, 2);
  assert.equal(worker.inspect().sent, undefined);
});

test('background rejects other extensions and never returns API key in config', async () => {
  const worker = background();
  assert.deepEqual(await worker.request({ action: 'modelConfig' }, 'other'), { accepted: false });
  const config = await worker.request({ action: 'modelConfig' });
  assert.equal(config.data.model, 'deepseek-flash');
  assert.equal(config.data.configured, true);
  assert.equal(JSON.stringify(config).includes(worker.inspect().secret), false);
});

test('background sends only to DeepSeek with non-thinking mode and bounded timeout', async () => {
  const worker = background();
  const result = await worker.request({ action: 'complete', request: { model: 'deepseek-flash', thinking: { type: 'disabled' }, messages: [] } });
  const { sent, timeout, secret } = worker.inspect();
  assert.equal(sent.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(JSON.parse(sent.init.body).thinking.type, 'disabled');
  assert.equal(timeout, 55000);
  assert.equal(result.data.usage.total_tokens, 9);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('model change during a task is a terminal configuration error', async () => {
  const worker = background();
  const result = await worker.request({ action: 'complete', request: { model: 'different' } });
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(worker.inspect().sent, undefined);
});

test('HTTP authentication errors retain status without exposing credentials', async () => {
  const worker = background({ status: 401 });
  const result = await worker.request({ action: 'complete', request: { model: 'deepseek-flash' } });
  assert.equal(result.status, 401);
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes(worker.inspect().secret), false);
});

test('truncated completion is rejected even if its prefix parses as JSON', async () => {
  const worker = background({ finish: 'length' });
  const result = await worker.request({ action: 'complete', request: { model: 'deepseek-flash' } });
  assert.equal(result.ok, false);
  assert.match(result.error, /未完整/);
});
