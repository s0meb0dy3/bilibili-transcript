import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');

function background() {
  const listeners = {};
  const calls = [];
  const event = name => ({ addListener: callback => { listeners[name] = callback; } });
  vm.runInNewContext(source, { chrome: {
    runtime: {
      onInstalled: event('installed'), onStartup: event('startup'),
      openOptionsPage: () => calls.push('options')
    },
    sidePanel: { setPanelBehavior: ({ openPanelOnActionClick }) => calls.push(openPanelOnActionClick) },
    contextMenus: {
      removeAll: () => calls.push('removeAll'),
      create: ({ id }) => calls.push(id), onClicked: event('menu')
    }
  } });
  return { listeners, calls };
}

test('side panel setup runs on installation and startup with one settings menu', async () => {
  const { listeners, calls } = background();
  assert.deepEqual(calls, []);
  await listeners.installed();
  await listeners.startup();
  assert.deepEqual(calls, [true, 'removeAll', 'settings', true, 'removeAll', 'settings']);
});

test('only the settings menu opens options', () => {
  const { listeners, calls } = background();
  listeners.menu({ menuItemId: 'unrelated' });
  assert.deepEqual(calls, []);
  listeners.menu({ menuItemId: 'settings' });
  assert.deepEqual(calls, ['options']);
});
