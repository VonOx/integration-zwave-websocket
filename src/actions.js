// -----------------------------------------------------------------------------
// Manifest actions (buttons in the Configuration screen):
//   - test_connection: connect to zwave-js-ui, report the node count.
//   - identify: opportunistic — only works on nodes exposing Indicator CC's
//     "identify" value; a harmless message otherwise.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { ZwaveClient } from './zwaveClient.js';
import { COMMAND_CLASSES } from './devices/ccMapping.js';
import { parseNodeId } from './devices/nodeDevice.js';

const logger = createLogger({ name: 'zwave-actions' });

export async function testConnection(config, { ZwaveClientClass = ZwaveClient } = {}) {
  const client = new ZwaveClientClass({
    host: config.host,
    port: config.port,
    ssl: config.ssl,
    useAuth: config.auth_required,
    username: config.username,
    password: config.password,
  });

  try {
    await client.connect();
    const nodeCount = client.getSnapshot().size;
    return {
      en: `Connected successfully. Found ${nodeCount} node(s).`,
      fr: `Connexion réussie. ${nodeCount} nœud(s) détecté(s).`,
    };
  } finally {
    client.disconnect();
  }
}

function findIdentifyValue(node) {
  return (node.values ?? []).find((value) => {
    if (value.commandClass !== COMMAND_CLASSES.INDICATOR) {
      return false;
    }
    const label = value.metadata?.label ?? value.propertyName ?? String(value.property ?? '');
    return /identify/i.test(label);
  });
}

export async function identifyDevice(zwaveClient, deviceExternalId) {
  const nodeId = parseNodeId(deviceExternalId);
  const node = nodeId === null ? undefined : zwaveClient.getSnapshot().get(nodeId);
  if (!node) {
    logger.warn(`identify: unknown device ${deviceExternalId}`);
    return {
      en: 'Unknown device.',
      fr: 'Appareil inconnu.',
    };
  }

  const identifyValue = findIdentifyValue(node);
  if (!identifyValue) {
    return {
      en: 'This device has no way to signal itself.',
      fr: "Cet appareil n'a aucun moyen de se signaler.",
    };
  }

  const valueId = {
    nodeId,
    commandClass: identifyValue.commandClass,
    endpoint: identifyValue.endpoint ?? 0,
    property: identifyValue.property,
  };
  if (identifyValue.propertyKey !== undefined) {
    valueId.propertyKey = identifyValue.propertyKey;
  }

  await zwaveClient.writeValue(valueId, true);
  return {
    en: 'Identify signal sent.',
    fr: "Signal d'identification envoyé.",
  };
}
