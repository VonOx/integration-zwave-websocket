// -----------------------------------------------------------------------------
// Dynamic device registry: rebuilds Gladys devices/features from the live
// zwave-js-ui snapshot (no static blueprint list). Keeps two indices so that
// resolving a write (feature external_id -> node/value) or a live push
// (node/value -> feature external_id) is a plain `Map.get`, never string
// parsing on the hot path.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { buildDeviceFromNode, nodeDeviceExternalId } from './nodeDevice.js';
import { valueKey } from './ccMapping.js';

const logger = createLogger({ name: 'zwave-devices' });

export function createNodeRegistry(gladys) {
  let featureIndex = new Map(); // feature external_id -> { nodeId, mapping }
  let valueIndex = new Map(); // "nodeId:mapping.key" -> feature external_id
  let deviceIndex = new Map(); // device external_id -> nodeId

  function rebuild(zwaveClient) {
    featureIndex = new Map();
    valueIndex = new Map();
    deviceIndex = new Map();

    const devices = [];
    for (const node of zwaveClient.getSnapshot().values()) {
      const { device, entries } = buildDeviceFromNode(gladys, node);
      if (entries.length === 0) {
        logger.debug(`Skipping node ${node.id}: no mapped features`);
        continue;
      }

      deviceIndex.set(device.external_id, node.id);
      for (const { mapping, externalId } of entries) {
        featureIndex.set(externalId, { nodeId: node.id, mapping });
        valueIndex.set(`${node.id}:${mapping.key}`, externalId);
      }
      devices.push(device);
    }
    return devices;
  }

  function buildCurrentStates(zwaveClient) {
    const states = [];
    for (const [featureExternalId, { nodeId, mapping }] of featureIndex) {
      const node = zwaveClient.getSnapshot().get(nodeId);
      const value = node?.values?.find((v) => valueKey(v) === mapping.key);
      if (value === undefined || value.value === undefined || value.value === null) {
        continue;
      }
      states.push({
        device_feature_external_id: featureExternalId,
        state: mapping.toGladys(value.value),
      });
    }
    return states;
  }

  function resolveFeature(featureExternalId) {
    return featureIndex.get(featureExternalId);
  }

  function resolveValueUpdate(value) {
    const featureExternalId = valueIndex.get(`${value.nodeId}:${valueKey(value)}`);
    if (!featureExternalId) {
      return null;
    }
    return { featureExternalId, ...featureIndex.get(featureExternalId) };
  }

  function getDeviceExternalId(nodeId) {
    return nodeDeviceExternalId(gladys, nodeId);
  }

  function getNodeIdForDevice(deviceExternalId) {
    return deviceIndex.get(deviceExternalId);
  }

  function getKnownNodeIds() {
    return [...deviceIndex.values()];
  }

  return {
    rebuild,
    buildCurrentStates,
    resolveFeature,
    resolveValueUpdate,
    getDeviceExternalId,
    getNodeIdForDevice,
    getKnownNodeIds,
  };
}

/** zwave-js-ui reports node liveness via `status`/`available`/`ready` — accept any of them. */
export function isNodeUnreachable(node) {
  if (!node) {
    return true;
  }
  if (typeof node.available === 'boolean' && !node.available) {
    return true;
  }
  if (typeof node.status === 'string' && /dead/i.test(node.status)) {
    return true;
  }
  return false;
}
