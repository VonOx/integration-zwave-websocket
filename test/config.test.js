import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, isConfigComplete, DEFAULT_CONFIG } from '../src/config.js';

test('normalizeConfig returns the defaults when called with no argument', () => {
  assert.deepEqual(normalizeConfig(), DEFAULT_CONFIG);
});

test('normalizeConfig keeps user values over the defaults', () => {
  const config = normalizeConfig({
    host: '192.168.1.50',
    port: 3099,
    ssl: true,
  });
  assert.equal(config.host, '192.168.1.50');
  assert.equal(config.port, 3099);
  assert.equal(config.ssl, true);
});

test('normalizeConfig coerces values coming from a form (strings for numbers/booleans)', () => {
  const config = normalizeConfig({
    host: ' 192.168.1.50 ',
    port: '3099',
    ssl: 'true',
  });
  assert.equal(config.host, '192.168.1.50');
  assert.equal(config.port, 3099);
  assert.equal(typeof config.port, 'number');
  assert.equal(config.ssl, true);
});

test('normalizeConfig falls back to the defaults for missing fields', () => {
  const config = normalizeConfig({ host: '192.168.1.50' });
  assert.equal(config.port, DEFAULT_CONFIG.port);
  assert.equal(config.ssl, DEFAULT_CONFIG.ssl);
});

test('isConfigComplete requires a host and port', () => {
  assert.equal(isConfigComplete(normalizeConfig()), false);
  assert.equal(isConfigComplete(normalizeConfig({ host: '192.168.1.50' })), true);
});
