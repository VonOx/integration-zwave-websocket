// -----------------------------------------------------------------------------
// Thin wrapper around zwave-js-server's WebSocket protocol (the documented
// gateway also used natively by Home Assistant/ioBroker/Node-RED) — NOT
// zwave-js-ui's own internal Socket.IO dashboard API.
//
// Nothing else in this codebase touches the WebSocket directly: callers only
// see plain events (`ready`, `value-updated`, `node-updated`, `node-added`,
// `node-removed`, `disconnected`, `error`) and a `nodes` Map snapshot, so the
// rest of the integration stays testable without a socket.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'zwave-client' });

export const ZWAVE_CLIENT_EVENTS = {
  READY: 'ready',
  VALUE_UPDATED: 'value-updated',
  NODE_UPDATED: 'node-updated',
  NODE_ADDED: 'node-added',
  NODE_REMOVED: 'node-removed',
  DISCONNECTED: 'disconnected',
  ERROR: 'error',
};

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

// We don't rely on any schema-version-specific field, so always request the
// highest version the server offers (clamped to its own min/max) rather than
// pinning a number we'd need to keep in sync with zwave-js-server releases.
const PREFERRED_SCHEMA_VERSION = 100;

const NODE_STATUS_LABELS = ['unknown', 'asleep', 'awake', 'dead', 'alive'];

const NODE_STATUS_EVENT_MAP = {
  dead: 'dead',
  alive: 'alive',
  'wake up': 'awake',
  sleep: 'asleep',
};

const VALUE_UPDATE_EVENT_NAMES = new Set(['value updated', 'value added', 'value notification']);

function normalizeNodeStatus(status) {
  return NODE_STATUS_LABELS[status] ?? 'unknown';
}

/** zwave-js-server uses `nodeId`/numeric `status`; the rest of this codebase expects `id`/string `status`. */
function normalizeNode(rawNode) {
  return {
    ...rawNode,
    id: rawNode.nodeId,
    status: normalizeNodeStatus(rawNode.status),
  };
}

function normalizeEventValue(event) {
  const { newValue, value, ...valueId } = event.args ?? {};
  return {
    nodeId: event.nodeId,
    ...valueId,
    value: newValue !== undefined ? newValue : value,
  };
}

export class ZwaveClient extends EventEmitter {
  constructor({
    host,
    port,
    ssl = false,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    wsFactory = (url) => new WebSocket(url),
  }) {
    super();
    this.host = host;
    this.port = port;
    this.ssl = ssl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.wsFactory = wsFactory;

    // Live snapshot of the network, keyed by Z-Wave node id. Rebuilt from
    // `start_listening` and kept current by node/controller push events.
    this.nodes = new Map();

    this.socket = null;
    this._pending = new Map(); // messageId -> { resolve, reject }
    this._messageIdCounter = 0;
    this._destroyed = false;

    // Node throws (crashing the process) if an 'error' event has zero
    // listeners at emit time. This class uses 'error' as an application-level
    // event, so guarantee at least one listener always exists regardless of
    // what the consumer wires up; logging already happens before every emit,
    // so this stays a safety net.
    this.on(ZWAVE_CLIENT_EVENTS.ERROR, () => {});
  }

  get wsUrl() {
    return `${this.ssl ? 'wss' : 'ws'}://${this.host}:${this.port}`;
  }

  /**
   * Connect and complete the initialize/start_listening handshake. Resolves
   * once the initial network snapshot is available (the `ready` event),
   * rejects if the connection or handshake fails or times out.
   */
  async connect() {
    this._destroyed = false;
    this.nodes.clear();
    this._pending = new Map();
    this._messageIdCounter = 0;

    return new Promise((resolve, reject) => {
      const socket = this.wsFactory(this.wsUrl);
      this.socket = socket;

      let settled = false;
      // zwave-js-server has no per-connection handshake acknowledgement of
      // its own beyond the initialize/start_listening replies (each already
      // guarded by _sendCommand's own timeout) — this outer timeout only
      // catches total silence (e.g. the server never even sends `version`),
      // so connect() can never hang forever regardless of what happens.
      const overallTimeout = setTimeout(() => {
        settleReject(new Error('operation has timed out'));
      }, this.requestTimeoutMs);

      const settleResolve = () => {
        if (settled) return;
        settled = true;
        clearTimeout(overallTimeout);
        this.off(ZWAVE_CLIENT_EVENTS.ERROR, onError);
        resolve();
      };
      const settleReject = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(overallTimeout);
        this.off(ZWAVE_CLIENT_EVENTS.READY, settleResolve);
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      const onError = (err) => settleReject(err);

      this.once(ZWAVE_CLIENT_EVENTS.READY, settleResolve);
      this.once(ZWAVE_CLIENT_EVENTS.ERROR, onError);

      socket.addEventListener('error', (event) => {
        this.emit(ZWAVE_CLIENT_EVENTS.ERROR, event?.error ?? new Error('WebSocket error'));
      });
      socket.addEventListener('close', (event) => this._handleClose(event));
      socket.addEventListener('message', (event) => this._onMessage(event));
    });
  }

  disconnect() {
    this._destroyed = true;
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // socket may already be closing/closed
      }
      this.socket = null;
    }
    this._rejectAllPending(new Error('Disconnected'));
    this.nodes.clear();
  }

  /** Live `Map<nodeId, node>` snapshot of the whole network. */
  getSnapshot() {
    return this.nodes;
  }

  /**
   * Write a Z-Wave value. `valueId = { nodeId, commandClass, endpoint, property, propertyKey }`.
   */
  async writeValue(valueId, value) {
    const { nodeId, commandClass, endpoint, property, propertyKey } = valueId;
    const trimmedValueId = { commandClass, endpoint: endpoint ?? 0, property };
    if (propertyKey !== undefined) {
      trimmedValueId.propertyKey = propertyKey;
    }

    const result = await this._sendCommand('node.set_value', {
      nodeId,
      valueId: trimmedValueId,
      value,
    });
    if (result && result.success === false) {
      throw new Error(result.message || 'zwave-js-server rejected the write');
    }
    return result;
  }

  _sendCommand(command, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.socket) {
        reject(new Error('Not connected to zwave-js-server'));
        return;
      }
      const messageId = String(++this._messageIdCounter);
      const timer = setTimeout(() => {
        this._pending.delete(messageId);
        reject(new Error(`operation has timed out (${command})`));
      }, this.requestTimeoutMs);
      this._pending.set(messageId, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.socket.send(JSON.stringify({ messageId, command, ...params }));
    });
  }

  _rejectAllPending(err) {
    for (const pending of this._pending.values()) {
      pending.reject(err);
    }
    this._pending.clear();
  }

  _onMessage(event) {
    if (this._destroyed) return;
    let payload;
    try {
      const raw = typeof event.data === 'string' ? event.data : event.data?.toString();
      payload = JSON.parse(raw);
    } catch (err) {
      logger.error('Failed to parse zwave-js-server message', err);
      return;
    }

    switch (payload.type) {
      case 'version':
        this._handleVersion(payload);
        break;
      case 'result':
        this._handleResult(payload);
        break;
      case 'event':
        this._handleEvent(payload.event);
        break;
      default:
        break;
    }
  }

  _handleClose(event) {
    if (this._destroyed) return;
    this.emit(ZWAVE_CLIENT_EVENTS.DISCONNECTED, event?.reason || 'closed');
    this._rejectAllPending(new Error('WebSocket closed'));
  }

  async _handleVersion(payload) {
    try {
      const schemaVersion = Math.max(
        payload.minSchemaVersion ?? 0,
        Math.min(PREFERRED_SCHEMA_VERSION, payload.maxSchemaVersion ?? PREFERRED_SCHEMA_VERSION),
      );
      await this._sendCommand('initialize', { schemaVersion });
      const { state } = await this._sendCommand('start_listening');
      this._applySnapshot(state);
      this.emit(ZWAVE_CLIENT_EVENTS.READY);
    } catch (err) {
      logger.error('zwave-js-server handshake failed', err);
      this.emit(ZWAVE_CLIENT_EVENTS.ERROR, err);
    }
  }

  _handleResult(payload) {
    const pending = this._pending.get(payload.messageId);
    if (!pending) {
      return;
    }
    this._pending.delete(payload.messageId);
    if (payload.success) {
      pending.resolve(payload.result);
    } else {
      pending.reject(
        new Error(
          payload.zwaveErrorMessage ||
            payload.message ||
            `zwave-js-server command failed (${payload.errorCode})`,
        ),
      );
    }
  }

  _applySnapshot(state) {
    this.nodes.clear();
    const nodes = state?.nodes ?? [];
    for (const rawNode of nodes) {
      const node = normalizeNode(rawNode);
      this.nodes.set(node.id, node);
    }
  }

  _handleEvent(event) {
    if (!event) return;
    if (event.source === 'node') {
      this._handleNodeEvent(event);
    } else if (event.source === 'controller') {
      this._handleControllerEvent(event);
    }
  }

  _handleNodeEvent(event) {
    const name = event.event;
    if (VALUE_UPDATE_EVENT_NAMES.has(name)) {
      this._handleValueUpdated(normalizeEventValue(event));
      return;
    }
    if (name === 'value removed') {
      this._handleValueRemoved(event);
      return;
    }
    if (name in NODE_STATUS_EVENT_MAP || name === 'ready') {
      this._handleNodeStatusEvent(name, event);
    }
  }

  _handleValueUpdated(value) {
    const node = this.nodes.get(value.nodeId);
    if (!node) {
      return;
    }
    const values = node.values ?? (node.values = []);
    const index = values.findIndex(
      (v) =>
        v.commandClass === value.commandClass &&
        v.endpoint === value.endpoint &&
        v.property === value.property &&
        v.propertyKey === value.propertyKey,
    );
    if (index >= 0) {
      values[index] = { ...values[index], ...value };
    } else {
      values.push(value);
    }
    this.emit(ZWAVE_CLIENT_EVENTS.VALUE_UPDATED, value);
  }

  _handleValueRemoved(event) {
    const node = this.nodes.get(event.nodeId);
    if (!node?.values) return;
    const valueId = event.args ?? {};
    const index = node.values.findIndex(
      (v) =>
        v.commandClass === valueId.commandClass &&
        v.endpoint === valueId.endpoint &&
        v.property === valueId.property &&
        v.propertyKey === valueId.propertyKey,
    );
    if (index >= 0) {
      node.values.splice(index, 1);
    }
  }

  _handleNodeStatusEvent(name, event) {
    const node = this.nodes.get(event.nodeId);
    if (!node) return;
    if (name in NODE_STATUS_EVENT_MAP) {
      node.status = NODE_STATUS_EVENT_MAP[name];
    }
    if (name === 'ready') {
      node.ready = true;
    }
    this.emit(ZWAVE_CLIENT_EVENTS.NODE_UPDATED, node);
  }

  _handleControllerEvent(event) {
    const name = event.event;
    if (name === 'node added' && event.node) {
      const node = normalizeNode(event.node);
      this.nodes.set(node.id, node);
      this.emit(ZWAVE_CLIENT_EVENTS.NODE_ADDED, node);
      return;
    }
    if (name === 'node removed' && event.node) {
      const nodeId = event.node.nodeId ?? event.node.id;
      this.nodes.delete(nodeId);
      this.emit(ZWAVE_CLIENT_EVENTS.NODE_REMOVED, { id: nodeId });
    }
  }
}
