import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, isConfigComplete, DEFAULT_CONFIG } from '../src/config.js';

test('normalizeConfig returns the defaults when called with no argument', () => {
  assert.deepEqual(normalizeConfig(), DEFAULT_CONFIG);
});

test('normalizeConfig keeps user values over the defaults', () => {
  const config = normalizeConfig({
    host: '192.168.1.50',
    port: 8091,
    ssl: true,
    auth_required: true,
    username: 'admin',
    password: 'secret',
  });
  assert.equal(config.host, '192.168.1.50');
  assert.equal(config.port, 8091);
  assert.equal(config.ssl, true);
  assert.equal(config.auth_required, true);
  assert.equal(config.username, 'admin');
  assert.equal(config.password, 'secret');
});

test('normalizeConfig coerces values coming from a form (strings for numbers/booleans)', () => {
  const config = normalizeConfig({
    host: ' 192.168.1.50 ',
    port: '8091',
    ssl: 'true',
    auth_required: 'true',
  });
  assert.equal(config.host, '192.168.1.50');
  assert.equal(config.port, 8091);
  assert.equal(typeof config.port, 'number');
  assert.equal(config.ssl, true);
  assert.equal(config.auth_required, true);
});

test('normalizeConfig falls back to the defaults for missing fields', () => {
  const config = normalizeConfig({ host: '192.168.1.50' });
  assert.equal(config.port, DEFAULT_CONFIG.port);
  assert.equal(config.ssl, DEFAULT_CONFIG.ssl);
  assert.equal(config.auth_required, DEFAULT_CONFIG.auth_required);
});

test('isConfigComplete requires a host and port', () => {
  assert.equal(isConfigComplete(normalizeConfig()), false);
  assert.equal(isConfigComplete(normalizeConfig({ host: '192.168.1.50' })), true);
});

test('isConfigComplete additionally requires credentials when auth_required is set', () => {
  const withoutCreds = normalizeConfig({ host: '192.168.1.50', auth_required: true });
  assert.equal(isConfigComplete(withoutCreds), false);

  const withCreds = normalizeConfig({
    host: '192.168.1.50',
    auth_required: true,
    username: 'admin',
    password: 'secret',
  });
  assert.equal(isConfigComplete(withCreds), true);
});
