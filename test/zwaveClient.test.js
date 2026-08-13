// -----------------------------------------------------------------------------
// Best-effort unit tests for ZwaveClient's own state machine (handshake,
// snapshot bookkeeping, write API), using an injected `ioFactory` returning a
// minimal fake socket. This validates our code, not zwave-js-ui's real wire
// behavior — see the manual verification checklist in the plan for that.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ZwaveClient, ZWAVE_CLIENT_EVENTS } from '../src/zwaveClient.js';

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.ackHandlers = {};
    this.disconnected = false;
  }
  timeout() {
    return { emitWithAck: (event, payload) => this._emitWithAck(event, payload) };
  }
  async _emitWithAck(event, payload) {
    const handler = this.ackHandlers[event];
    if (!handler) {
      throw new Error(`FakeSocket: no ack handler registered for "${event}"`);
    }
    return handler(payload);
  }
  disconnect() {
    this.disconnected = true;
  }
}

function createFakeIoFactory({ nodes = [] } = {}) {
  let socket;
  const ioFactory = (url, opts) => {
    socket = new FakeSocket();
    socket.url = url;
    socket.ioOpts = opts;
    socket.ackHandlers.INITED = async () => ({ nodes });
    socket.ackHandlers.SUBSCRIBE = async () => ({});
    // Real socket.io only fires 'connect' once listeners are attached; mimic
    // that ordering instead of emitting synchronously inside the factory.
    queueMicrotask(() => socket.emit('connect'));
    return socket;
  };
  return { ioFactory, getSocket: () => socket };
}

test('connect() completes the INITED/SUBSCRIBE handshake and populates the snapshot', async () => {
  const { ioFactory, getSocket } = createFakeIoFactory({ nodes: [{ id: 1, values: [] }] });
  const client = new ZwaveClient({ host: 'zwave.local', port: 8091, ioFactory });

  await client.connect();

  assert.equal(client.getSnapshot().size, 1);
  assert.equal(getSocket().ioOpts.transports[0], 'websocket');
});

test('VALUE_UPDATED pushes update the cached node and re-emit as value-updated', async () => {
  const { ioFactory, getSocket } = createFakeIoFactory({ nodes: [{ id: 1, values: [] }] });
  const client = new ZwaveClient({ host: 'zwave.local', port: 8091, ioFactory });
  await client.connect();

  const updates = [];
  client.on(ZWAVE_CLIENT_EVENTS.VALUE_UPDATED, (v) => updates.push(v));

  getSocket().emit('VALUE_UPDATED', {
    nodeId: 1,
    commandClass: 38,
    endpoint: 0,
    property: 'currentValue',
    value: 42,
  });

  assert.equal(updates.length, 1);
  assert.equal(client.getSnapshot().get(1).values[0].value, 42);
});

test('writeValue emits the ZWAVE_API/writeValue call and resolves with the ack result', async () => {
  const { ioFactory, getSocket } = createFakeIoFactory({ nodes: [{ id: 1, values: [] }] });
  const client = new ZwaveClient({ host: 'zwave.local', port: 8091, ioFactory });
  await client.connect();

  let received;
  getSocket().ackHandlers.ZWAVE_API = async (payload) => {
    received = payload;
    return { success: true, result: 'ok' };
  };

  const valueId = { nodeId: 1, commandClass: 38, endpoint: 0, property: 'targetValue' };
  const result = await client.writeValue(valueId, 50);

  assert.equal(result, 'ok');
  assert.deepEqual(received, { api: 'writeValue', args: [valueId, 50] });
});

test('writeValue rejects when zwave-js-ui reports failure', async () => {
  const { ioFactory, getSocket } = createFakeIoFactory({ nodes: [{ id: 1, values: [] }] });
  const client = new ZwaveClient({ host: 'zwave.local', port: 8091, ioFactory });
  await client.connect();

  getSocket().ackHandlers.ZWAVE_API = async () => ({
    success: false,
    message: 'node unresponsive',
  });

  await assert.rejects(() => client.writeValue({ nodeId: 1 }, true), /node unresponsive/);
});

test('disconnect tears down the socket and clears the snapshot', async () => {
  const { ioFactory, getSocket } = createFakeIoFactory({ nodes: [{ id: 1, values: [] }] });
  const client = new ZwaveClient({ host: 'zwave.local', port: 8091, ioFactory });
  await client.connect();

  client.disconnect();

  assert.equal(getSocket().disconnected, true);
  assert.equal(client.getSnapshot().size, 0);
});

test('useAuth authenticates over HTTP before connecting and passes the token through the auth callback', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push(String(url));
    if (String(url).includes('/api/auth-enabled')) {
      return { ok: true, json: async () => ({ enabled: true }) };
    }
    if (String(url).includes('/api/authenticate')) {
      assert.equal(opts.method, 'POST');
      return { ok: true, json: async () => ({ token: 'tok-123' }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const { ioFactory, getSocket } = createFakeIoFactory({ nodes: [] });
    const client = new ZwaveClient({
      host: 'zwave.local',
      port: 8091,
      useAuth: true,
      username: 'admin',
      password: 'secret',
      ioFactory,
    });

    await client.connect();

    const authFn = getSocket().ioOpts.auth;
    const received = await new Promise((resolve) => authFn(resolve));
    assert.deepEqual(received, { token: 'tok-123' });
    assert.ok(calls.some((u) => u.includes('/api/authenticate')));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
