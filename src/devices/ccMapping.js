// -----------------------------------------------------------------------------
// Generic Z-Wave Command Class -> Gladys device-feature mapping layer.
//
// Pure functions only (no SDK/socket dependency) so this stays fully
// unit-testable: given a zwave-js-ui node snapshot, produce the list of
// Gladys features it should expose, plus enough metadata (`readValueId`,
// `writeValueId`, `toGladys`/`toZwave`) for the caller to wire reads/writes
// without ever re-parsing a value id.
//
// Command Classes with a dedicated mapper are handled precisely; every other
// CC still gets *something* via `mapGenericFallback` instead of being
// invisible, since the integration must ultimately cope with any CC a node
// exposes, not just the ones we know about today.
// -----------------------------------------------------------------------------

import {
  createLogger,
  DEVICE_FEATURE_CATEGORIES as CAT,
  DEVICE_FEATURE_TYPES as TYPE,
  DEVICE_FEATURE_UNITS as UNIT,
} from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'cc-mapping' });

export const COMMAND_CLASSES = {
  BINARY_SWITCH: 0x25,
  MULTILEVEL_SWITCH: 0x26,
  BINARY_SENSOR: 0x30,
  MULTILEVEL_SENSOR: 0x31,
  NOTIFICATION: 0x71,
  INDICATOR: 0x87,
  BATTERY: 0x80,
};

// Management/transport CCs: never turned into a feature, skipped before any
// mapper sees them. Indicator (0x87) is included here even though the
// `identify` action reads/writes it directly: it's used opportunistically for
// that one purpose, not surfaced as a regular device feature.
export const INTERNAL_COMMAND_CLASSES = new Set([
  0x59, // Association Group Information
  0x5a, // Device Reset Locally
  0x5e, // Z-Wave Plus Info
  0x6c, // Supervision
  0x70, // Configuration
  0x72, // Manufacturer Specific
  0x73, // Powerlevel
  0x7a, // Firmware Update Meta Data
  0x84, // Wake Up
  0x85, // Association
  0x86, // Version
  0x87, // Indicator (handled opportunistically by the `identify` action)
  0x8e, // Multi Channel Association
]);

/** zwave-js 0-99 level <-> Gladys 0-100%. 255 is the legacy "restore last on level". */
export function multilevelToPercent(level) {
  if (level === 255) {
    return 100;
  }
  return Math.max(0, Math.min(100, Math.round((level / 99) * 100)));
}

export function percentToMultilevel(percent) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  return Math.round((clamped / 100) * 99);
}

/**
 * Device-class aware classification for Multilevel Switch: fan controllers
 * and motor-control (shutter/blind) loads get their own category instead of
 * defaulting every dimmable load to LIGHT.
 */
export function classifyMultilevelSwitch(node) {
  const genericLabel = node?.deviceClass?.generic?.label ?? '';
  const specificLabel = node?.deviceClass?.specific?.label ?? '';
  const label = `${genericLabel} ${specificLabel}`;

  if (/fan/i.test(label)) {
    return { category: CAT.FAN, type: TYPE.FAN.PERCENT, name: 'Speed' };
  }
  if (/motor|shutter|blind|curtain|awning/i.test(label)) {
    return { category: CAT.SHUTTER, type: TYPE.SHUTTER.POSITION, name: 'Position' };
  }
  return { category: CAT.LIGHT, type: TYPE.LIGHT.BRIGHTNESS, name: 'Brightness' };
}

const SENSOR_LABEL_HINTS = [
  { pattern: /temperature/i, category: CAT.TEMPERATURE_SENSOR, unit: UNIT.CELSIUS },
  { pattern: /humidity/i, category: CAT.HUMIDITY_SENSOR, unit: UNIT.PERCENT },
  { pattern: /illuminance/i, category: CAT.LIGHT_SENSOR, unit: UNIT.LUX },
  { pattern: /co2/i, category: CAT.CO2_SENSOR },
  { pattern: /\bco\b/i, category: CAT.CO_SENSOR },
  { pattern: /pressure/i, category: CAT.PRESSURE_SENSOR, unit: UNIT.HECTO_PASCAL },
  { pattern: /uv/i, category: CAT.UV_SENSOR },
  { pattern: /velocity|wind/i, category: CAT.SPEED_SENSOR },
];

const PRESENCE_LABEL_HINTS = [
  { pattern: /tamper/i, category: CAT.TAMPER, type: TYPE.TAMPER.BINARY },
  { pattern: /motion/i, category: CAT.MOTION_SENSOR, type: TYPE.SENSOR.BINARY },
  {
    pattern: /door|window|access control/i,
    category: CAT.OPENING_SENSOR,
    type: TYPE.SENSOR.BINARY,
  },
  { pattern: /smoke/i, category: CAT.SMOKE_SENSOR, type: TYPE.SENSOR.BINARY },
  { pattern: /water|flood|leak/i, category: CAT.LEAK_SENSOR, type: TYPE.SENSOR.BINARY },
];

const UNIT_LOOKUP = {
  '°C': UNIT.CELSIUS,
  '°F': UNIT.FAHRENHEIT,
  '%': UNIT.PERCENT,
  lux: UNIT.LUX,
  Lux: UNIT.LUX,
  W: UNIT.WATT,
  V: UNIT.VOLT,
  A: UNIT.AMPERE,
  hPa: UNIT.HECTO_PASCAL,
};

/** Stable identity for one zwave-js-ui value, independent of its current reading. */
export function valueKey(value) {
  const endpoint = value.endpoint ?? 0;
  const propertyKey = value.propertyKey !== undefined ? `:${value.propertyKey}` : '';
  return `${endpoint}:${value.commandClass}:${value.property}${propertyKey}`;
}

function toValueId(nodeId, value) {
  const valueId = {
    nodeId,
    commandClass: value.commandClass,
    endpoint: value.endpoint ?? 0,
    property: value.property,
  };
  if (value.propertyKey !== undefined) {
    valueId.propertyKey = value.propertyKey;
  }
  return valueId;
}

function featureName(endpoint, label) {
  return endpoint ? `${label} (endpoint ${endpoint})` : label;
}

function valueLabel(value, fallback) {
  return value.metadata?.label ?? value.propertyName ?? fallback;
}

export function mapMultilevelSwitch(node, endpoint, values) {
  const currentValue = values.find((v) => v.property === 'currentValue');
  const targetValue = values.find((v) => v.property === 'targetValue');
  const readValue = currentValue ?? targetValue;
  if (!readValue) {
    return [];
  }

  const { category, type, name } = classifyMultilevelSwitch(node);

  return [
    {
      key: valueKey(readValue),
      name: featureName(endpoint, name),
      category,
      type,
      unit: UNIT.PERCENT,
      min: 0,
      max: 100,
      read_only: !targetValue,
      has_feedback: true,
      keep_history: true,
      readValueId: toValueId(node.id, readValue),
      writeValueId: targetValue ? toValueId(node.id, targetValue) : undefined,
      toGladys: (raw) => multilevelToPercent(raw),
      toZwave: (percent) => percentToMultilevel(percent),
    },
  ];
}

export function mapBinarySwitch(node, endpoint, values) {
  const currentValue = values.find((v) => v.property === 'currentValue');
  const targetValue = values.find((v) => v.property === 'targetValue');
  const readValue = currentValue ?? targetValue;
  if (!readValue) {
    return [];
  }

  return [
    {
      key: valueKey(readValue),
      name: featureName(endpoint, 'Switch'),
      category: CAT.SWITCH,
      type: TYPE.SWITCH.BINARY,
      read_only: !targetValue,
      has_feedback: true,
      keep_history: true,
      readValueId: toValueId(node.id, readValue),
      writeValueId: targetValue ? toValueId(node.id, targetValue) : undefined,
      toGladys: (raw) => (raw ? 1 : 0),
      toZwave: (value) => value === 1 || value === true,
    },
  ];
}

export function mapMultilevelSensor(node, endpoint, values) {
  const features = [];
  for (const value of values) {
    if (typeof value.value !== 'number') {
      continue;
    }
    const label = valueLabel(value, 'Sensor');
    const hint = SENSOR_LABEL_HINTS.find((h) => h.pattern.test(label));
    features.push({
      key: valueKey(value),
      name: featureName(endpoint, label),
      category: hint?.category ?? CAT.UNKNOWN,
      type: TYPE.SENSOR.DECIMAL,
      unit: UNIT_LOOKUP[value.metadata?.unit] ?? hint?.unit,
      read_only: true,
      has_feedback: true,
      keep_history: true,
      readValueId: toValueId(node.id, value),
      writeValueId: undefined,
      toGladys: (raw) => raw,
    });
  }
  return features;
}

function mapPresenceValues(node, endpoint, values) {
  const features = [];
  for (const value of values) {
    if (typeof value.value !== 'boolean' && typeof value.value !== 'number') {
      continue;
    }
    const label = valueLabel(value, 'Sensor');
    const hint = PRESENCE_LABEL_HINTS.find((h) => h.pattern.test(label));
    features.push({
      key: valueKey(value),
      name: featureName(endpoint, label),
      category: hint?.category ?? CAT.UNKNOWN,
      type: hint?.type ?? TYPE.SENSOR.BINARY,
      read_only: true,
      has_feedback: true,
      keep_history: true,
      readValueId: toValueId(node.id, value),
      writeValueId: undefined,
      toGladys: (raw) => (raw ? 1 : 0),
    });
  }
  return features;
}

export function mapBinarySensor(node, endpoint, values) {
  return mapPresenceValues(node, endpoint, values);
}

export function mapNotification(node, endpoint, values) {
  return mapPresenceValues(node, endpoint, values);
}

export function mapBattery(node, endpoint, values) {
  const features = [];
  const level = values.find((v) => v.property === 'level');
  const isLow = values.find((v) => v.property === 'isLow');

  if (level) {
    features.push({
      key: valueKey(level),
      name: featureName(endpoint, 'Battery'),
      category: CAT.BATTERY,
      type: TYPE.BATTERY.INTEGER,
      unit: UNIT.PERCENT,
      min: 0,
      max: 100,
      read_only: true,
      has_feedback: true,
      keep_history: true,
      readValueId: toValueId(node.id, level),
      writeValueId: undefined,
      toGladys: (raw) => raw,
    });
  }

  if (isLow) {
    features.push({
      key: valueKey(isLow),
      name: featureName(endpoint, 'Battery low'),
      category: CAT.BATTERY_LOW,
      type: TYPE.BATTERY_LOW.BINARY,
      read_only: true,
      has_feedback: true,
      keep_history: true,
      readValueId: toValueId(node.id, isLow),
      writeValueId: undefined,
      toGladys: (raw) => (raw ? 1 : 0),
    });
  }

  return features;
}

/** Any Command Class without a dedicated mapper: degrade gracefully, never crash. */
export function mapGenericFallback(node, commandClass, endpoint, values) {
  const features = [];
  for (const value of values) {
    const label = valueLabel(value, `CC ${commandClass}`);
    const writable = Boolean(value.metadata?.writeable);

    if (typeof value.value === 'boolean') {
      features.push({
        key: valueKey(value),
        name: featureName(endpoint, label),
        category: CAT.UNKNOWN,
        type: TYPE.SENSOR.BINARY,
        read_only: !writable,
        has_feedback: true,
        keep_history: true,
        readValueId: toValueId(node.id, value),
        writeValueId: writable ? toValueId(node.id, value) : undefined,
        toGladys: (raw) => (raw ? 1 : 0),
        toZwave: (v) => v === 1 || v === true,
      });
    } else if (typeof value.value === 'number') {
      features.push({
        key: valueKey(value),
        name: featureName(endpoint, label),
        category: CAT.UNKNOWN,
        type: TYPE.SENSOR.DECIMAL,
        read_only: !writable,
        has_feedback: true,
        keep_history: true,
        readValueId: toValueId(node.id, value),
        writeValueId: writable ? toValueId(node.id, value) : undefined,
        toGladys: (raw) => raw,
        toZwave: (v) => v,
      });
    } else {
      logger.debug(
        `Skipping unsupported value ${valueKey(value)} on node ${node?.id} (type: ${typeof value.value})`,
      );
    }
  }
  return features;
}

function mapCommandClassGroup(node, commandClass, endpoint, values) {
  switch (commandClass) {
    case COMMAND_CLASSES.MULTILEVEL_SWITCH:
      return mapMultilevelSwitch(node, endpoint, values);
    case COMMAND_CLASSES.BINARY_SWITCH:
      return mapBinarySwitch(node, endpoint, values);
    case COMMAND_CLASSES.MULTILEVEL_SENSOR:
      return mapMultilevelSensor(node, endpoint, values);
    case COMMAND_CLASSES.BINARY_SENSOR:
      return mapBinarySensor(node, endpoint, values);
    case COMMAND_CLASSES.NOTIFICATION:
      return mapNotification(node, endpoint, values);
    case COMMAND_CLASSES.BATTERY:
      return mapBattery(node, endpoint, values);
    default:
      return mapGenericFallback(node, commandClass, endpoint, values);
  }
}

/**
 * Group a node's values by `endpoint:commandClass` and dispatch each group to
 * its mapper. Returns the full flat list of feature-mapping objects for the
 * node (never throws on an unrecognized CC — see `mapGenericFallback`).
 */
export function buildFeaturesForNode(node) {
  const values = Array.isArray(node?.values) ? node.values : [];
  const groups = new Map();

  for (const value of values) {
    if (value == null || value.commandClass == null) {
      continue;
    }
    if (INTERNAL_COMMAND_CLASSES.has(value.commandClass)) {
      continue;
    }
    const endpoint = value.endpoint ?? 0;
    const groupKey = `${endpoint}:${value.commandClass}`;
    if (!groups.has(groupKey)) {
      groups.set(groupKey, []);
    }
    groups.get(groupKey).push(value);
  }

  const features = [];
  for (const [groupKey, groupValues] of groups) {
    const [endpointStr, ccStr] = groupKey.split(':');
    features.push(...mapCommandClassGroup(node, Number(ccStr), Number(endpointStr), groupValues));
  }
  return features;
}
