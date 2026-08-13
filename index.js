// -----------------------------------------------------------------------------
// Entry point of the Gladys external integration.
//
// Connects to zwave-js-ui's native Socket.IO API (port 8091 by default) and
// mirrors its live node/value snapshot into Gladys devices/features. All the
// Z-Wave protocol logic lives in src/zwaveClient.js and src/devices/; this
// file only wires the SDK lifecycle to that snapshot.
//
// Environment variables provided by the Gladys supervisor to the container:
//   - GLADYS_HOST_API_URL         (host API URL)
//   - GLADYS_INTEGRATION_TOKEN    (integration-scoped JWT)
//   - GLADYS_INTEGRATION_SELECTOR (integration identifier)
// The SDK reads them automatically: `new GladysIntegration()` is enough.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger, DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import { normalizeConfig, isConfigComplete } from './src/config.js';
import { ZwaveClient, ZWAVE_CLIENT_EVENTS } from './src/zwaveClient.js';
import { createNodeRegistry, isNodeUnreachable } from './src/devices/index.js';
import { testConnection, identifyDevice } from './src/actions.js';

const gladys = new GladysIntegration();

// Current configuration (hot-reloaded via onConfigUpdated).
let config = normalizeConfig();

// Rebuilt on every discovery pass; resolves feature <-> node/value lookups.
const registry = createNodeRegistry(gladys);

// The live socket connection to zwave-js-ui. Null while disconnected/unconfigured.
let zwaveClient = null;

async function publishDiscovery() {
  const devices = registry.rebuild(zwaveClient);
  await gladys.publishDiscoveredDevices(devices);
}

async function publishInitialStates() {
  const states = registry.buildCurrentStates(zwaveClient);
  for (let i = 0; i < states.length; i += 100) {
    await gladys.publishStates(states.slice(i, i + 100));
  }
}

// Reused for offline/dead nodes, repurposing the same transport-badge
// mechanism a dual-channel device would use for its cloud fallback.
async function publishUnreachableBadges() {
  const entries = [];
  for (const node of zwaveClient.getSnapshot().values()) {
    if (isNodeUnreachable(node)) {
      entries.push({
        external_id: registry.getDeviceExternalId(node.id),
        transport: DEVICE_TRANSPORTS.UNREACHABLE,
      });
    }
  }
  if (entries.length > 0) {
    await gladys.publishTransports(entries);
  }
}

function wireZwaveClient(client) {
  client.on(ZWAVE_CLIENT_EVENTS.READY, async () => {
    try {
      await publishDiscovery();
      await publishInitialStates();
      await publishUnreachableBadges();
      await gladys.setConnectionStatus(true);
    } catch (err) {
      logger.error('Post-connection initialization failed', err);
      await gladys
        .setConnectionStatus(false, {
          en: 'Initialization failed, check the integration logs.',
          fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
        })
        .catch(() => {});
    }
  });

  client.on(ZWAVE_CLIENT_EVENTS.VALUE_UPDATED, async (value) => {
    const resolved = registry.resolveValueUpdate(value);
    if (!resolved) {
      return;
    }
    try {
      await gladys.publishState(resolved.featureExternalId, resolved.mapping.toGladys(value.value));
    } catch (err) {
      logger.error('publishState failed', err);
    }
  });

  client.on(ZWAVE_CLIENT_EVENTS.NODE_ADDED, async () => {
    try {
      await publishDiscovery();
    } catch (err) {
      logger.error('Discovery refresh failed', err);
    }
  });

  client.on(ZWAVE_CLIENT_EVENTS.NODE_UPDATED, async (node) => {
    try {
      await publishUnreachableBadges();
      if (!isNodeUnreachable(node)) {
        // Coming back online (or reporting new info) may expose new features.
        await publishDiscovery();
      }
    } catch (err) {
      logger.error('Node update handling failed', err);
    }
  });

  client.on(ZWAVE_CLIENT_EVENTS.NODE_REMOVED, async (node) => {
    // Never delete the device: only flag it unreachable, same constraint as
    // any dual-channel device that loses both its transports.
    try {
      await gladys.publishTransports([
        {
          external_id: registry.getDeviceExternalId(node.id),
          transport: DEVICE_TRANSPORTS.UNREACHABLE,
        },
      ]);
    } catch (err) {
      logger.error('Transport publish failed', err);
    }
  });

  client.on(ZWAVE_CLIENT_EVENTS.DISCONNECTED, () => {
    logger.warn('Disconnected from zwave-js-ui');
    gladys
      .setConnectionStatus(false, {
        en: 'Disconnected from zwave-js-ui.',
        fr: 'Déconnecté de zwave-js-ui.',
      })
      .catch(() => {});
  });

  client.on(ZWAVE_CLIENT_EVENTS.ERROR, (err) => {
    logger.error('zwave-js-ui client error', err);
  });
}

function disconnectZwave() {
  if (zwaveClient) {
    zwaveClient.disconnect();
    zwaveClient = null;
  }
}

async function connectZwave() {
  disconnectZwave();

  if (!isConfigComplete(config)) {
    logger.warn('Configuration incomplete, waiting for host/credentials.');
    await gladys
      .setConnectionStatus(false, {
        en: 'Configure the zwave-js-ui host first.',
        fr: "Configurez d'abord l'hôte zwave-js-ui.",
      })
      .catch(() => {});
    return;
  }

  zwaveClient = new ZwaveClient({
    host: config.host,
    port: config.port,
    ssl: config.ssl,
    useAuth: config.auth_required,
    username: config.username,
    password: config.password,
  });
  wireZwaveClient(zwaveClient);

  try {
    await zwaveClient.connect();
  } catch (err) {
    logger.error('Connection to zwave-js-ui failed', err);
    await gladys
      .setConnectionStatus(false, {
        en: 'Could not connect to zwave-js-ui, check host/credentials.',
        fr: "Connexion à zwave-js-ui impossible, vérifiez l'hôte et les identifiants.",
      })
      .catch(() => {});
  }
}

// --- Discovery: Gladys asks for the list of devices --------------------------
gladys.onScanRequest(async () => {
  logger.info('onScanRequest -> publishing discovered devices');
  await gladys.publishDiscoveredDevices(zwaveClient ? registry.rebuild(zwaveClient) : []);
});

// --- Command: the user acts on a controllable feature ------------------------
gladys.onSetValue(async (device, feature, value) => {
  logger.info(`onSetValue <- ${feature.external_id} = ${value}`);
  if (!zwaveClient) {
    throw new Error('Not connected to zwave-js-ui');
  }
  const resolved = registry.resolveFeature(feature.external_id);
  if (!resolved || resolved.mapping.read_only || !resolved.mapping.writeValueId) {
    throw new Error(`No command handler for ${feature.external_id}`);
  }
  const rawValue = resolved.mapping.toZwave(value);
  await zwaveClient.writeValue(
    { nodeId: resolved.nodeId, ...resolved.mapping.writeValueId },
    rawValue,
  );
});

// --- Polling: Gladys asks to refresh a device --------------------------------
// Z-Wave here is push-driven over the socket; this only re-publishes the
// current cached snapshot for that device, it never queries zwave-js-ui.
gladys.onPoll(async (device) => {
  if (!zwaveClient) {
    return;
  }
  const nodeId = registry.getNodeIdForDevice(device.external_id);
  if (nodeId === undefined) {
    return;
  }
  const states = registry
    .buildCurrentStates(zwaveClient)
    .filter(
      (state) => registry.resolveFeature(state.device_feature_external_id)?.nodeId === nodeId,
    );
  if (states.length > 0) {
    await gladys.publishStates(states);
  }
});

// --- Manifest actions: buttons in the Configuration screen -------------------
gladys.onAction('test_connection', () => testConnection(config));

// The `identify` action targets ONE device chosen by the user; its manifest
// field declares `"source": "devices"` (SDK v0.7+), so the Configuration
// screen fills the select with the integration's own created devices.
gladys.onAction('identify', (fields) => {
  logger.info(`Action identify <- ${fields.device}`);
  if (!zwaveClient) {
    return { en: 'Not connected to zwave-js-ui.', fr: 'Non connecté à zwave-js-ui.' };
  }
  return identifyDevice(zwaveClient, fields.device);
});

// --- Configuration updated by the user ---------------------------------------
gladys.onConfigUpdated(async (newConfig) => {
  logger.info('onConfigUpdated -> new configuration received');
  config = normalizeConfig(newConfig);
  // Host/port/credentials may have changed: reconnect from scratch.
  await connectZwave();
});

// --- Connection lifecycle ----------------------------------------------------
gladys.on('connected', async () => {
  try {
    config = normalizeConfig(await gladys.getConfig());
    await connectZwave();
  } catch (err) {
    logger.error('Post-connection initialization failed', err);
    await gladys
      .setConnectionStatus(false, {
        en: 'Initialization failed, check the integration logs.',
        fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
      })
      .catch(() => {});
  }
});

gladys.on('disconnected', () => {
  disconnectZwave();
});

// --- Graceful shutdown -------------------------------------------------------
gladys.handleShutdown((signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
  disconnectZwave();
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the Z-Wave (zwave-js-ui) integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
