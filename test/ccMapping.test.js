import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEVICE_FEATURE_CATEGORIES as CAT,
  DEVICE_FEATURE_TYPES as TYPE,
  DEVICE_FEATURE_UNITS as UNIT,
} from '@gladysassistant/integration-sdk';
import {
  COMMAND_CLASSES,
  INTERNAL_COMMAND_CLASSES,
  multilevelToPercent,
  percentToMultilevel,
  classifyMultilevelSwitch,
  valueKey,
  mapMultilevelSwitch,
  mapBinarySwitch,
  mapMultilevelSensor,
  mapBinarySensor,
  mapNotification,
  mapBattery,
  mapGenericFallback,
  buildFeaturesForNode,
} from '../src/devices/ccMapping.js';

test('multilevelToPercent converts the zwave-js 0-99 domain, with 255 as the legacy "restore last level"', () => {
  assert.equal(multilevelToPercent(0), 0);
  assert.equal(multilevelToPercent(99), 100);
  assert.equal(multilevelToPercent(50), 51);
  assert.equal(multilevelToPercent(255), 100);
});

test('percentToMultilevel converts Gladys 0-100% back to the zwave-js 0-99 domain, clamping out-of-range input', () => {
  assert.equal(percentToMultilevel(0), 0);
  assert.equal(percentToMultilevel(100), 99);
  assert.equal(percentToMultilevel(51), 50);
  assert.equal(percentToMultilevel(150), 99);
  assert.equal(percentToMultilevel(-10), 0);
});

test('classifyMultilevelSwitch defaults dimmable loads to LIGHT/BRIGHTNESS', () => {
  const node = {
    deviceClass: {
      generic: { label: 'Multilevel Switch' },
      specific: { label: 'Multilevel Power Switch' },
    },
  };
  const result = classifyMultilevelSwitch(node);
  assert.equal(result.category, CAT.LIGHT);
  assert.equal(result.type, TYPE.LIGHT.BRIGHTNESS);
});

test('classifyMultilevelSwitch maps fan controllers to FAN/PERCENT', () => {
  const node = {
    deviceClass: { generic: { label: 'Multilevel Switch' }, specific: { label: 'Fan Switch' } },
  };
  const result = classifyMultilevelSwitch(node);
  assert.equal(result.category, CAT.FAN);
  assert.equal(result.type, TYPE.FAN.PERCENT);
});

test('classifyMultilevelSwitch maps motor-control loads to SHUTTER/POSITION', () => {
  const node = {
    deviceClass: {
      generic: { label: 'Multilevel Switch' },
      specific: { label: 'Motor Control Class B' },
    },
  };
  const result = classifyMultilevelSwitch(node);
  assert.equal(result.category, CAT.SHUTTER);
  assert.equal(result.type, TYPE.SHUTTER.POSITION);
});

test('valueKey is stable across endpoint/commandClass/property/propertyKey', () => {
  assert.equal(
    valueKey({ endpoint: 0, commandClass: 38, property: 'currentValue' }),
    '0:38:currentValue',
  );
  assert.equal(
    valueKey({ endpoint: 2, commandClass: 113, property: 'Home Security', propertyKey: 8 }),
    '2:113:Home Security:8',
  );
});

test('mapMultilevelSwitch exposes one read/write feature classified by device class', () => {
  const node = {
    id: 5,
    deviceClass: { generic: { label: 'Multilevel Switch' }, specific: { label: 'Fan Switch' } },
  };
  const values = [
    {
      commandClass: COMMAND_CLASSES.MULTILEVEL_SWITCH,
      endpoint: 0,
      property: 'currentValue',
      value: 50,
    },
    {
      commandClass: COMMAND_CLASSES.MULTILEVEL_SWITCH,
      endpoint: 0,
      property: 'targetValue',
      value: 50,
    },
  ];
  const [feature] = mapMultilevelSwitch(node, 0, values);
  assert.equal(feature.category, CAT.FAN);
  assert.equal(feature.type, TYPE.FAN.PERCENT);
  assert.equal(feature.read_only, false);
  assert.equal(feature.toGladys(99), 100);
  assert.equal(feature.toZwave(100), 99);
  assert.deepEqual(feature.writeValueId, {
    nodeId: 5,
    commandClass: COMMAND_CLASSES.MULTILEVEL_SWITCH,
    endpoint: 0,
    property: 'targetValue',
  });
});

test('mapMultilevelSwitch is read-only when there is no targetValue', () => {
  const node = { id: 5, deviceClass: {} };
  const values = [
    {
      commandClass: COMMAND_CLASSES.MULTILEVEL_SWITCH,
      endpoint: 0,
      property: 'currentValue',
      value: 20,
    },
  ];
  const [feature] = mapMultilevelSwitch(node, 0, values);
  assert.equal(feature.read_only, true);
  assert.equal(feature.writeValueId, undefined);
});

test('mapBinarySwitch maps to SWITCH/BINARY', () => {
  const node = { id: 7 };
  const values = [
    {
      commandClass: COMMAND_CLASSES.BINARY_SWITCH,
      endpoint: 0,
      property: 'currentValue',
      value: true,
    },
    {
      commandClass: COMMAND_CLASSES.BINARY_SWITCH,
      endpoint: 0,
      property: 'targetValue',
      value: true,
    },
  ];
  const [feature] = mapBinarySwitch(node, 0, values);
  assert.equal(feature.category, CAT.SWITCH);
  assert.equal(feature.type, TYPE.SWITCH.BINARY);
  assert.equal(feature.toGladys(true), 1);
  assert.equal(feature.toZwave(1), true);
});

test('mapMultilevelSensor recognizes a known label and picks up its unit', () => {
  const node = { id: 9 };
  const values = [
    {
      commandClass: COMMAND_CLASSES.MULTILEVEL_SENSOR,
      endpoint: 0,
      property: 'Air temperature',
      value: 21.5,
      metadata: { label: 'Air temperature', unit: '°C' },
    },
  ];
  const [feature] = mapMultilevelSensor(node, 0, values);
  assert.equal(feature.category, CAT.TEMPERATURE_SENSOR);
  assert.equal(feature.unit, UNIT.CELSIUS);
  assert.equal(feature.toGladys(21.5), 21.5);
});

test('mapMultilevelSensor falls back to UNKNOWN/DECIMAL for an unrecognized label', () => {
  const node = { id: 9 };
  const values = [
    {
      commandClass: COMMAND_CLASSES.MULTILEVEL_SENSOR,
      endpoint: 0,
      property: 'Some Weird Value',
      value: 3,
      metadata: { label: 'Some Weird Value' },
    },
  ];
  const [feature] = mapMultilevelSensor(node, 0, values);
  assert.equal(feature.category, CAT.UNKNOWN);
  assert.equal(feature.type, TYPE.SENSOR.DECIMAL);
});

test('mapBinarySensor and mapNotification classify presence values via label hints', () => {
  const node = { id: 11 };
  const motion = [
    {
      commandClass: COMMAND_CLASSES.BINARY_SENSOR,
      endpoint: 0,
      property: 'Motion sensor status',
      value: true,
      metadata: { label: 'Motion sensor status' },
    },
  ];
  const [motionFeature] = mapBinarySensor(node, 0, motion);
  assert.equal(motionFeature.category, CAT.MOTION_SENSOR);
  assert.equal(motionFeature.type, TYPE.SENSOR.BINARY);

  const tamper = [
    {
      commandClass: COMMAND_CLASSES.NOTIFICATION,
      endpoint: 0,
      property: 'Tampering Product Cover',
      value: true,
      metadata: { label: 'Tampering Product Cover' },
    },
  ];
  const [tamperFeature] = mapNotification(node, 0, tamper);
  assert.equal(tamperFeature.category, CAT.TAMPER);
  assert.equal(tamperFeature.type, TYPE.TAMPER.BINARY);
});

test('mapBattery exposes level and isLow as separate features', () => {
  const node = { id: 13 };
  const values = [
    { commandClass: COMMAND_CLASSES.BATTERY, endpoint: 0, property: 'level', value: 80 },
    { commandClass: COMMAND_CLASSES.BATTERY, endpoint: 0, property: 'isLow', value: false },
  ];
  const features = mapBattery(node, 0, values);
  assert.equal(features.length, 2);

  const level = features.find((f) => f.category === CAT.BATTERY);
  assert.equal(level.type, TYPE.BATTERY.INTEGER);
  assert.equal(level.toGladys(80), 80);

  const isLow = features.find((f) => f.category === CAT.BATTERY_LOW);
  assert.equal(isLow.type, TYPE.BATTERY_LOW.BINARY);
  assert.equal(isLow.toGladys(false), 0);
});

test('mapGenericFallback handles booleans and numbers, skips unsupported types', () => {
  const node = { id: 17 };
  const values = [
    {
      commandClass: 999,
      endpoint: 0,
      property: 'someBool',
      value: true,
      metadata: { writeable: true },
    },
    { commandClass: 999, endpoint: 0, property: 'someNumber', value: 3.14 },
    { commandClass: 999, endpoint: 0, property: 'someString', value: 'unsupported' },
  ];
  const features = mapGenericFallback(node, 999, 0, values);
  assert.equal(features.length, 2);

  assert.equal(features[0].category, CAT.UNKNOWN);
  assert.equal(features[0].type, TYPE.SENSOR.BINARY);
  assert.equal(features[0].read_only, false);
  assert.equal(features[0].toZwave(true), true);

  assert.equal(features[1].type, TYPE.SENSOR.DECIMAL);
  assert.equal(features[1].read_only, true);
});

test('buildFeaturesForNode skips internal command classes entirely', () => {
  const node = {
    id: 21,
    values: [...INTERNAL_COMMAND_CLASSES].map((cc) => ({
      commandClass: cc,
      endpoint: 0,
      property: 'value',
      value: 1,
    })),
  };
  assert.deepEqual(buildFeaturesForNode(node), []);
});

test('buildFeaturesForNode groups values by endpoint:commandClass and dispatches to the right mapper', () => {
  const node = {
    id: 23,
    deviceClass: { generic: { label: 'Multilevel Switch' }, specific: {} },
    values: [
      {
        commandClass: COMMAND_CLASSES.MULTILEVEL_SWITCH,
        endpoint: 0,
        property: 'currentValue',
        value: 10,
      },
      {
        commandClass: COMMAND_CLASSES.MULTILEVEL_SWITCH,
        endpoint: 0,
        property: 'targetValue',
        value: 10,
      },
      { commandClass: COMMAND_CLASSES.BATTERY, endpoint: 0, property: 'level', value: 90 },
      { commandClass: 0x70, endpoint: 0, property: 'someConfig', value: 1 },
    ],
  };
  const features = buildFeaturesForNode(node);
  assert.equal(features.length, 2);
  assert.ok(features.some((f) => f.category === CAT.LIGHT));
  assert.ok(features.some((f) => f.category === CAT.BATTERY));
});
