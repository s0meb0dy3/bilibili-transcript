import test from 'node:test';
import assert from 'node:assert/strict';
import { initialAvatar } from '../extension/avatar.js';

test('creates a circular initial avatar as an inline SVG', () => {
  const url = initialAvatar('魏晞', '0');
  assert.match(url, /^data:image\/svg\+xml/);
  assert.match(decodeURIComponent(url), /魏/);
  assert.match(decodeURIComponent(url), /<circle/);
});
