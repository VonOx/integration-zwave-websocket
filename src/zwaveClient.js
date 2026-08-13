// -----------------------------------------------------------------------------
// Thin wrapper around zwave-js-ui's NATIVE Socket.IO API (the one its own Vue
// dashboard uses, default port 8091) — not the separate zwave-js-server
// JSON-RPC gateway (port 3000).
//
// Nothing else in this codebase touches socket.io-client directly: callers
// only see plain events (`ready`, `value-updated`, `node-updated`,
// `node-added`, `node-removed`, `disconnected`, `error`) and a `nodes` Map
// snapshot, so the rest of the integration stays testable without a socket.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { io as ioClient } from 'socket.io-client';
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

export class ZwaveClient extends EventEmitter {
  constructor({
    host,
    port,
    ssl = false,
    useAuth = false,
    username = '',
    password = '',
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    ioFactory = ioClient,
  }) {
    super();
    this.host = host;
    this.port = port;
    this.ssl = ssl;
    this.useAuth = useAuth;
    this.username = username;
    this.password = password;
    this.requestTimeoutMs = requestTimeoutMs;
    this.ioFactory = ioFactory;

    // Live snapshot of the network, keyed by Z-Wave node id. Rebuilt from the
    // `INITED` ack and kept current by VALUE_UPDATED/NODE_UPDATED/NODE_REMOVED.
    this.nodes = new Map();

    this.socket = null;
    this._token = null; // in-memory only: never written to disk (read-only rootfs)
  }

  get baseUrl() {
    return `${this.ssl ? 'https' : 'http'}://${this.host}:${this.port}`;
  }

  /**
   * Connect, authenticate if needed, and complete the INITED/SUBSCRIBE
   * handshake. Resolves once the initial network snapshot is available
   * (the `ready` event), rejects if the connection or handshake fails.
   */
  async connect() {
    if (this.useAuth) {
      await this._authenticate();
    }

    return new Promise((resolve, reject) => {
      const socket = this.ioFactory(this.baseUrl, {
        transports: ['websocket'],
        reconnection: true,
        // A function lets a refreshed token be picked up on every reconnect
        // attempt, since socket.io-client does not replay this handshake.
        auth: (cb) => cb(this.useAuth ? { token: this._token } : {}),
      });
      this.socket = socket;

      let settled = false;
      const onReady = () => {
        if (settled) return;
        settled = true;
        socket.off('connect_error', onConnectError);
        resolve();
      };
      const onConnectError = (err) => {
        if (settled) return;
        settled = true;
        this.off(ZWAVE_CLIENT_EVENTS.READY, onReady);
        reject(err instanceof Error ? err : new Error(String(err)));
      };

      this.once(ZWAVE_CLIENT_EVENTS.READY, onReady);
      socket.once('connect_error', onConnectError);

      this._attachListeners(socket);
    });
  }

  disconnect() {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }
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
    return this._callApi('writeValue', [valueId, value]);
  }

  async _callApi(api, args) {
    if (!this.socket) {
      throw new Error('Not connected to zwave-js-ui');
    }
    const ack = await this.socket
      .timeout(this.requestTimeoutMs)
      .emitWithAck('ZWAVE_API', { api, args });
    if (!ack?.success) {
      throw new Error(ack?.message ?? `zwave-js-ui API call "${api}" failed`);
    }
    return ack.result;
  }

  async _authenticate() {
    try {
      const res = await fetch(`${this.baseUrl}/api/auth-enabled`, {
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
      if (res.ok) {
        const body = await res.json();
        if (body?.enabled === false) {
          logger.warn('zwave-js-ui reports authentication disabled, but auth_required is set');
        }
      }
    } catch (err) {
      logger.debug('auth-enabled check failed (continuing anyway)', err);
    }

    const res = await fetch(`${this.baseUrl}/api/authenticate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: this.username, password: this.password }),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (!res.ok) {
      throw new Error(`zwave-js-ui authentication failed: HTTP ${res.status}`);
    }
    const body = await res.json();
    const token = body?.token ?? body?.data?.token;
    if (!token) {
      throw new Error('zwave-js-ui authentication response did not contain a token');
    }
    this._token = token;
  }

  _attachListeners(socket) {
    // socket.io-client's built-in reconnection does NOT replay INITED/SUBSCRIBE:
    // 'connect' fires on first connect AND every reconnect, so redo it every time.
    socket.on('connect', () => this._onConnect(socket));
    socket.on('disconnect', (reason) => {
      this.emit(ZWAVE_CLIENT_EVENTS.DISCONNECTED, reason);
    });
    socket.on('connect_error', async (err) => {
      logger.error('Connection error', err);
      if (this.useAuth) {
        try {
          await this._authenticate();
        } catch (authErr) {
          logger.error('Re-authentication failed', authErr);
        }
      }
      this.emit(ZWAVE_CLIENT_EVENTS.ERROR, err);
    });

    socket.on('VALUE_UPDATED', (value) => this._handleValueUpdated(value));
    socket.on('NODE_UPDATED', (node) =>
      this._handleNodeUpdated(node, ZWAVE_CLIENT_EVENTS.NODE_UPDATED),
    );
    socket.on('NODE_ADDED', (node) =>
      this._handleNodeUpdated(node, ZWAVE_CLIENT_EVENTS.NODE_ADDED),
    );
    socket.on('NODE_REMOVED', (node) => this._handleNodeRemoved(node));
  }

  async _onConnect(socket) {
    try {
      const snapshot = await socket.timeout(this.requestTimeoutMs).emitWithAck('INITED');
      this._applySnapshot(snapshot);
      await socket.timeout(this.requestTimeoutMs).emitWithAck('SUBSCRIBE', { target: 'ZWAVE' });
      this.emit(ZWAVE_CLIENT_EVENTS.READY);
    } catch (err) {
      logger.error('Handshake (INITED/SUBSCRIBE) failed', err);
      this.emit(ZWAVE_CLIENT_EVENTS.ERROR, err);
    }
  }

  _applySnapshot(snapshot) {
    this.nodes.clear();
    const nodes = snapshot?.nodes ?? snapshot?.state?.nodes ?? [];
    for (const node of nodes) {
      this.nodes.set(node.id, node);
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

  _handleNodeUpdated(node, eventName) {
    this.nodes.set(node.id, node);
    this.emit(eventName, node);
  }

  _handleNodeRemoved(node) {
    this.nodes.delete(node.id);
    this.emit(ZWAVE_CLIENT_EVENTS.NODE_REMOVED, node);
  }
}
