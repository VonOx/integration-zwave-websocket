// -----------------------------------------------------------------------------
// One Gladys device per Z-Wave node (not per endpoint) — endpoint is encoded
// into each feature's key/name instead. Turns a zwave-js-ui node snapshot into
// the `{ device, features }` shape the SDK expects for discovery.
// -----------------------------------------------------------------------------

import { buildFeaturesForNode } from './ccMapping.js';

const DEVICE_TYPE = 'zwave-node';

export function nodeDeviceExternalId(gladys, nodeId) {
  return gladys.externalIds(DEVICE_TYPE, String(nodeId)).device;
}

/** Best-effort reverse of `nodeDeviceExternalId`: the node id is always the last `:`-segment. */
export function parseNodeId(externalId) {
  if (!externalId) {
    return null;
  }
  const segments = externalId.split(':');
  const nodeId = Number(segments[segments.length - 1]);
  return Number.isNaN(nodeId) ? null : nodeId;
}

function nodeName(node) {
  return (
    node.name ||
    node.deviceClass?.specific?.label ||
    node.deviceClass?.generic?.label ||
    `Node ${node.id}`
  );
}

/**
 * @returns {{ device: object, entries: Array<{ mapping: object, externalId: string }> }}
 * `entries` pairs each feature mapping with the external_id it was published
 * under, so the caller can index reads/writes without re-deriving keys.
 */
export function buildDeviceFromNode(gladys, node) {
  const ids = gladys.externalIds(DEVICE_TYPE, String(node.id));
  const mappings = buildFeaturesForNode(node);

  const entries = mappings.map((mapping) => ({
    mapping,
    externalId: ids.feature(mapping.key),
  }));

  const features = entries.map(({ mapping, externalId }) => ({
    name: mapping.name,
    external_id: externalId,
    category: mapping.category,
    type: mapping.type,
    unit: mapping.unit,
    min: mapping.min,
    max: mapping.max,
    read_only: mapping.read_only,
    has_feedback: mapping.has_feedback,
    keep_history: mapping.keep_history,
  }));

  return {
    device: {
      name: nodeName(node),
      external_id: ids.device,
      features,
    },
    entries,
  };
}
