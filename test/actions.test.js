import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testConnection, identifyDevice } from '../src/actions.js';
import { COMMAND_CLASSES } from '../src/devices/ccMapping.js';

class FakeZwaveClient {
  constructor({ nodes = [], connectError } = {}) {
    this._nodes = new Map(nodes.map((n) => [n.id, n]));
    this._connectError = connectError;
    this.disconnected = false;
    this.writeCalls = [];
  }
  async connect() {
    if (this._connectError) {
      throw this._connectError;
    }
  }
  disconnect() {
    this.disconnected = true;
  }
  getSnapshot() {
    return this._nodes;
  }
  async writeValue(valueId, value) {
    this.writeCalls.push({ valueId, value });
  }
}

const baseConfig = {
  host: '192.168.1.50',
  port: 3000,
  ssl: false,
};

test('testConnection reports the node count and always disconnects', async () => {
  let created;
  const ZwaveClientClass = function () {
    created = new FakeZwaveClient({ nodes: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    return created;
  };

  const result = await testConnection(baseConfig, { ZwaveClientClass });
  assert.match(result.en, /3/);
  assert.match(result.fr, /3/);
  assert.equal(created.disconnected, true);
});

test('testConnection disconnects even when the connection fails', async () => {
  let created;
  const ZwaveClientClass = function () {
    created = new FakeZwaveClient({ connectError: new Error('boom') });
    return created;
  };

  await assert.rejects(() => testConnection(baseConfig, { ZwaveClientClass }), /boom/);
  assert.equal(created.disconnected, true);
});

test('identifyDevice reports an unknown device', async () => {
  const client = new FakeZwaveClient({ nodes: [] });
  const result = await identifyDevice(client, 'zwave-node:1');
  assert.match(result.en, /Unknown/);
});

test('identifyDevice reports when a device has no identify value', async () => {
  const client = new FakeZwaveClient({ nodes: [{ id: 1, values: [] }] });
  const result = await identifyDevice(client, 'zwave-node:1');
  assert.match(result.en, /no way to signal/);
});

test('identifyDevice writes true to the Indicator identify value', async () => {
  const client = new FakeZwaveClient({
    nodes: [
      {
        id: 1,
        values: [
          {
            commandClass: COMMAND_CLASSES.INDICATOR,
            endpoint: 0,
            property: 'value',
            propertyKey: 4,
            metadata: { label: 'Identify' },
          },
        ],
      },
    ],
  });

  const result = await identifyDevice(client, 'zwave-node:1');

  assert.equal(client.writeCalls.length, 1);
  assert.deepEqual(client.writeCalls[0].valueId, {
    nodeId: 1,
    commandClass: COMMAND_CLASSES.INDICATOR,
    endpoint: 0,
    property: 'value',
    propertyKey: 4,
  });
  assert.equal(client.writeCalls[0].value, true);
  assert.match(result.en, /sent/i);
});
