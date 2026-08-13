import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from './helpers/fakeGladys.js';
import {
  nodeDeviceExternalId,
  parseNodeId,
  buildDeviceFromNode,
} from '../src/devices/nodeDevice.js';
import { createNodeRegistry, isNodeUnreachable } from '../src/devices/index.js';
import { COMMAND_CLASSES } from '../src/devices/ccMapping.js';

function fixtureNode(overrides = {}) {
  return {
    id: 10,
    deviceClass: { generic: { label: 'Multilevel Switch' }, specific: {} },
    values: [
      {
        commandClass: COMMAND_CLASSES.MULTILEVEL_SWITCH,
        endpoint: 0,
        property: 'currentValue',
        value: 40,
      },
      {
        commandClass: COMMAND_CLASSES.MULTILEVEL_SWITCH,
        endpoint: 0,
        property: 'targetValue',
        value: 40,
      },
    ],
    ...overrides,
  };
}

test('nodeDeviceExternalId / parseNodeId round-trip', () => {
  const gladys = createFakeGladys();
  const externalId = nodeDeviceExternalId(gladys, 42);
  assert.equal(parseNodeId(externalId), 42);
});

test('parseNodeId returns null for an unparseable external_id', () => {
  assert.equal(parseNodeId(''), null);
  assert.equal(parseNodeId(undefined), null);
  assert.equal(parseNodeId('zwave-node:not-a-number'), null);
});

test('buildDeviceFromNode names the device from the node, falling back to "Node N"', () => {
  const gladys = createFakeGladys();

  const named = buildDeviceFromNode(gladys, fixtureNode({ name: 'Living Room Dimmer' }));
  assert.equal(named.device.name, 'Living Room Dimmer');

  const labeled = buildDeviceFromNode(
    gladys,
    fixtureNode({
      name: undefined,
      deviceClass: { generic: { label: 'Multilevel Switch' }, specific: { label: 'Fan Switch' } },
    }),
  );
  assert.equal(labeled.device.name, 'Fan Switch');

  const fallback = buildDeviceFromNode(gladys, fixtureNode({ name: undefined, deviceClass: {} }));
  assert.equal(fallback.device.name, 'Node 10');
});

test('buildDeviceFromNode pairs each feature with its published external_id', () => {
  const gladys = createFakeGladys();
  const { device, entries } = buildDeviceFromNode(gladys, fixtureNode());
  assert.equal(entries.length, 1);
  assert.equal(device.features.length, 1);
  assert.equal(device.features[0].external_id, entries[0].externalId);
  assert.equal(device.features[0].external_id, `zwave-node:10:${entries[0].mapping.key}`);
});

test('buildDeviceFromNode returns zero entries for a node with no mappable features', () => {
  const gladys = createFakeGladys();
  const { entries } = buildDeviceFromNode(gladys, { id: 99, values: [] });
  assert.equal(entries.length, 0);
});

test('createNodeRegistry rebuilds devices from the zwave client snapshot, skipping empty nodes', () => {
  const gladys = createFakeGladys();
  const registry = createNodeRegistry(gladys);
  const snapshot = new Map([
    [10, fixtureNode()],
    [99, { id: 99, values: [] }],
  ]);
  const fakeClient = { getSnapshot: () => snapshot };

  const devices = registry.rebuild(fakeClient);
  assert.equal(devices.length, 1);
  assert.equal(devices[0].external_id, 'zwave-node:10');
  assert.equal(registry.getNodeIdForDevice('zwave-node:10'), 10);
  assert.deepEqual(registry.getKnownNodeIds(), [10]);
});

test('createNodeRegistry resolves feature writes and value-updated pushes via its indices', () => {
  const gladys = createFakeGladys();
  const registry = createNodeRegistry(gladys);
  const snapshot = new Map([[10, fixtureNode()]]);
  const fakeClient = { getSnapshot: () => snapshot };
  registry.rebuild(fakeClient);

  const featureExternalId = 'zwave-node:10:0:38:currentValue';
  const resolved = registry.resolveFeature(featureExternalId);
  assert.equal(resolved.nodeId, 10);
  assert.equal(resolved.mapping.toGladys(99), 100);

  const update = registry.resolveValueUpdate({
    nodeId: 10,
    commandClass: COMMAND_CLASSES.MULTILEVEL_SWITCH,
    endpoint: 0,
    property: 'currentValue',
  });
  assert.equal(update.featureExternalId, featureExternalId);

  assert.equal(
    registry.resolveValueUpdate({ nodeId: 999, commandClass: 0, endpoint: 0, property: 'x' }),
    null,
  );
});

test('createNodeRegistry.buildCurrentStates reads the live value for every mapped feature', () => {
  const gladys = createFakeGladys();
  const registry = createNodeRegistry(gladys);
  const snapshot = new Map([[10, fixtureNode()]]);
  const fakeClient = { getSnapshot: () => snapshot };
  registry.rebuild(fakeClient);

  const states = registry.buildCurrentStates(fakeClient);
  assert.equal(states.length, 1);
  assert.equal(states[0].device_feature_external_id, 'zwave-node:10:0:38:currentValue');
  assert.equal(states[0].state, 40); // multilevelToPercent(40) = round(40/99*100) = 40
});

test('createNodeRegistry drops stale index entries after a node disappears from the snapshot', () => {
  const gladys = createFakeGladys();
  const registry = createNodeRegistry(gladys);

  registry.rebuild({ getSnapshot: () => new Map([[10, fixtureNode()]]) });
  assert.ok(registry.resolveFeature('zwave-node:10:0:38:currentValue'));

  registry.rebuild({ getSnapshot: () => new Map() });
  assert.equal(registry.resolveFeature('zwave-node:10:0:38:currentValue'), undefined);
  assert.equal(registry.getNodeIdForDevice('zwave-node:10'), undefined);
});

test('isNodeUnreachable reflects availability/status/missing node', () => {
  assert.equal(isNodeUnreachable(undefined), true);
  assert.equal(isNodeUnreachable({ available: false }), true);
  assert.equal(isNodeUnreachable({ status: 'Dead' }), true);
  assert.equal(isNodeUnreachable({ available: true, status: 'Alive' }), false);
});
