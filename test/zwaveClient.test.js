// -----------------------------------------------------------------------------
// Best-effort unit tests for ZwaveClient's own state machine (handshake,
// snapshot bookkeeping, write API), using an injected `wsFactory` returning a
// minimal fake WebSocket. This validates our code, not zwave-js-server's real
// wire behavior — see the manual verification checklist in the plan for that.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZwaveClient, ZWAVE_CLIENT_EVENTS } from '../src/zwaveClient.js';

class FakeSocket {
  constructor() {
    this.listeners = { message: [], close: [], error: [] };
    this.sent = [];
    this.closed = false;
  }
  addEventListener(type, cb) {
    this.listeners[type].push(cb);
  }
  send(data) {
    this.sent.push(data);
    const payload = JSON.parse(data);
    const handler = this.commandHandlers[payload.command];
    if (!handler) return;
    queueMicrotask(() => {
      const outcome = handler(payload);
      this.emitMessage({ type: 'result', messageId: payload.messageId, ...outcome });
    });
  }
  close() {
    this.closed = true;
  }
  emitMessage(payload) {
    for (const cb of this.listeners.message) {
      cb({ data: JSON.stringify(payload) });
    }
  }
}

function createFakeWsFactory({ nodes = [], version = {} } = {}) {
  let socket;
  const wsFactory = (url) => {
    socket = new FakeSocket();
    socket.url = url;
    socket.commandHandlers = {
      initialize: () => ({ success: true, result: {} }),
      start_listening: () => ({ success: true, result: { state: { nodes } } }),
    };
    queueMicrotask(() => {
      socket.emitMessage({
        type: 'version',
        driverVersion: '1.0.0',
        serverVersion: '1.0.0',
        homeId: 1,
        minSchemaVersion: 0,
        maxSchemaVersion: 100,
        ...version,
      });
    });
    return socket;
  };
  return { wsFactory, getSocket: () => socket };
}

test('connect() completes the initialize/start_listening handshake and populates the snapshot', async () => {
  const { wsFactory, getSocket } = createFakeWsFactory({
    nodes: [{ nodeId: 1, status: 4, values: [] }],
  });
  const client = new ZwaveClient({ host: 'zwave.local', port: 3000, wsFactory });

  await client.connect();

  assert.equal(client.getSnapshot().size, 1);
  const node = client.getSnapshot().get(1);
  assert.equal(node.id, 1);
  assert.equal(node.status, 'alive');
  assert.equal(getSocket().url, 'ws://zwave.local:3000');
});

test('a "value updated" event pushes into the cache and re-emits VALUE_UPDATED', async () => {
  const { wsFactory, getSocket } = createFakeWsFactory({
    nodes: [{ nodeId: 1, status: 4, values: [] }],
  });
  const client = new ZwaveClient({ host: 'zwave.local', port: 3000, wsFactory });
  await client.connect();

  const updates = [];
  client.on(ZWAVE_CLIENT_EVENTS.VALUE_UPDATED, (v) => updates.push(v));

  getSocket().emitMessage({
    type: 'event',
    event: {
      source: 'node',
      event: 'value updated',
      nodeId: 1,
      args: { commandClass: 38, endpoint: 0, property: 'currentValue', newValue: 42, prevValue: 0 },
    },
  });

  assert.equal(updates.length, 1);
  assert.equal(updates[0].value, 42);
  assert.equal(client.getSnapshot().get(1).values[0].value, 42);
});

test('a "dead" node event updates the cached status and emits NODE_UPDATED', async () => {
  const { wsFactory, getSocket } = createFakeWsFactory({
    nodes: [{ nodeId: 1, status: 4, values: [] }],
  });
  const client = new ZwaveClient({ host: 'zwave.local', port: 3000, wsFactory });
  await client.connect();

  let updated;
  client.on(ZWAVE_CLIENT_EVENTS.NODE_UPDATED, (node) => (updated = node));

  getSocket().emitMessage({
    type: 'event',
    event: { source: 'node', event: 'dead', nodeId: 1 },
  });

  assert.equal(updated.status, 'dead');
  assert.equal(client.getSnapshot().get(1).status, 'dead');
});

test('writeValue sends a trimmed node.set_value command and resolves with the result', async () => {
  const { wsFactory, getSocket } = createFakeWsFactory({
    nodes: [{ nodeId: 1, status: 4, values: [] }],
  });
  const client = new ZwaveClient({ host: 'zwave.local', port: 3000, wsFactory });
  await client.connect();

  let received;
  getSocket().commandHandlers['node.set_value'] = (payload) => {
    received = payload;
    return { success: true, result: { success: true } };
  };

  const valueId = {
    nodeId: 1,
    commandClass: 38,
    endpoint: 0,
    property: 'targetValue',
    value: 99,
    metadata: {},
  };
  const result = await client.writeValue(valueId, 50);

  assert.deepEqual(result, { success: true });
  assert.equal(received.nodeId, 1);
  assert.equal(received.value, 50);
  assert.deepEqual(received.valueId, { commandClass: 38, endpoint: 0, property: 'targetValue' });
});

test('writeValue throws when zwave-js-server reports the write failed', async () => {
  const { wsFactory, getSocket } = createFakeWsFactory({
    nodes: [{ nodeId: 1, status: 4, values: [] }],
  });
  const client = new ZwaveClient({ host: 'zwave.local', port: 3000, wsFactory });
  await client.connect();

  getSocket().commandHandlers['node.set_value'] = () => ({
    success: true,
    result: { success: false, message: 'node unresponsive' },
  });

  await assert.rejects(
    () =>
      client.writeValue(
        { nodeId: 1, commandClass: 38, endpoint: 0, property: 'targetValue' },
        true,
      ),
    /node unresponsive/,
  );
});

test('connect() rejects when the handshake fails instead of hanging forever', async () => {
  const { wsFactory, getSocket } = createFakeWsFactory({ nodes: [] });
  const client = new ZwaveClient({ host: 'zwave.local', port: 3000, wsFactory });

  const connectPromise = client.connect();
  getSocket().commandHandlers.initialize = () => ({ success: false, message: 'schema mismatch' });

  await assert.rejects(connectPromise, /schema mismatch/);
});

test('a handshake failure never crashes the process even without an external error listener', async () => {
  const { wsFactory, getSocket } = createFakeWsFactory({ nodes: [] });
  const client = new ZwaveClient({ host: 'zwave.local', port: 3000, wsFactory });

  const connectPromise = client.connect();
  getSocket().commandHandlers.initialize = () => ({ success: false, message: 'boom' });
  await assert.rejects(connectPromise);

  // A second, later handshake failure (e.g. a reconnect attempt) on the same
  // client must still not throw, even though nothing external is listening.
  assert.doesNotThrow(() => {
    client.emit(ZWAVE_CLIENT_EVENTS.ERROR, new Error('boom again'));
  });
});

test('a "node removed" controller event emits NODE_REMOVED with the node id', async () => {
  const { wsFactory, getSocket } = createFakeWsFactory({
    nodes: [{ nodeId: 1, status: 4, values: [] }],
  });
  const client = new ZwaveClient({ host: 'zwave.local', port: 3000, wsFactory });
  await client.connect();

  let removed;
  client.on(ZWAVE_CLIENT_EVENTS.NODE_REMOVED, (payload) => (removed = payload));

  getSocket().emitMessage({
    type: 'event',
    event: { source: 'controller', event: 'node removed', node: { nodeId: 1 }, reason: 0 },
  });

  assert.deepEqual(removed, { id: 1 });
  assert.equal(client.getSnapshot().size, 0);
});

test('disconnect closes the socket and clears the snapshot', async () => {
  const { wsFactory, getSocket } = createFakeWsFactory({
    nodes: [{ nodeId: 1, status: 4, values: [] }],
  });
  const client = new ZwaveClient({ host: 'zwave.local', port: 3000, wsFactory });
  await client.connect();

  client.disconnect();

  assert.equal(getSocket().closed, true);
  assert.equal(client.getSnapshot().size, 0);
});
