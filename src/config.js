// -----------------------------------------------------------------------------
// Integration configuration.
//
// The configuration is filled in by the user in Gladys, from the `config_schema`
// declared in `gladys-assistant-integration.json`. The SDK fetches it for you
// (`gladys.getConfig()`) and notifies you of every change through
// `gladys.onConfigUpdated()`.
//
// This module only provides defaults and normalizes the received object, so the
// rest of the code never has to deal with `undefined`.
// -----------------------------------------------------------------------------

// Defaults: they MUST stay consistent with the `default` values declared in the
// `config_schema` of the manifest.
export const DEFAULT_CONFIG = {
  host: '',
  port: 8091,
  ssl: false,
  auth_required: false,
  username: '',
  password: '',
};

/**
 * Merge the user config with the defaults.
 * @param {Record<string, unknown>} raw config returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    host: String(raw.host ?? DEFAULT_CONFIG.host).trim(),
    port: Number(raw.port ?? DEFAULT_CONFIG.port),
    ssl: raw.ssl === true || raw.ssl === 'true',
    auth_required: raw.auth_required === true || raw.auth_required === 'true',
    username: String(raw.username ?? DEFAULT_CONFIG.username),
    password: String(raw.password ?? DEFAULT_CONFIG.password),
  };
}

/**
 * True once there is enough information to attempt a connection: a host/port
 * are set, and credentials are present whenever authentication is required.
 * @param {ReturnType<typeof normalizeConfig>} config
 */
export function isConfigComplete(config) {
  if (!config.host || !config.port) {
    return false;
  }
  if (config.auth_required && (!config.username || !config.password)) {
    return false;
  }
  return true;
}
