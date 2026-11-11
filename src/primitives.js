import {createHash, createHmac} from 'node:crypto';

export class HarborError extends Error {
  constructor(kind, message, context = {}, status = 400) {
    super(message);
    this.name = 'HarborError';
    this.kind = kind;
    this.context = context;
    this.status = status;
  }
  document() {
    return {error: this.kind, message: this.message, context: this.context};
  }
}
export function demand(condition, kind, message, context = {}, status = 400) {
  if (!condition) {
    throw new HarborError(kind, message, context, status);
  }
}
export function dictionary(value, label = 'input') {
  demand(value !== null && typeof value === 'object' && !Array.isArray(value),
    'shape', `${label} must be an object`);
  demand(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null,
    'shape', `${label} must be plain data`);
  return value;
}
export function fields(value, allowed, required = []) {
  dictionary(value);
  for (const key of Object.keys(value)) {
    demand(allowed.includes(key), 'field', `Unsupported field ${key}`);
  }
  for (const key of required) {
    demand(Object.hasOwn(value, key), 'required', `Required field ${key} is absent`);
  }
}
export function label(value, name = 'text', maximum = 256) {
  demand(typeof value === 'string', 'text', `${name} must be text`);
  const cleaned = value.trim().normalize('NFC');
  demand(cleaned.length > 0 && cleaned.length <= maximum, 'text', `${name} length is invalid`);
  demand(![...cleaned].some(character => character.charCodeAt(0) < 32), 'text', `${name} contains control characters`);
  return cleaned;
}
export function key(value, name = 'id') {
  const result = label(value, name, 80);
  demand(/^[a-z][a-z0-9_-]*$/.test(result), 'identifier', `${name} must use lowercase letters, digits, underscore or hyphen`);
  demand(!['constructor', 'prototype', '__proto__'].includes(result), 'identifier', `${name} is reserved`);
  return result;
}
export function count(value, name, low = 0, high = Number.MAX_SAFE_INTEGER) {
  demand(Number.isSafeInteger(value) && value >= low && value <= high, 'integer', `${name} is outside bounds`);
  return value;
}
export function finite(value, name, low = -Infinity, high = Infinity) {
  demand(typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high,
    'number', `${name} must be a finite number within bounds`);
  return Object.is(value, -0) ? 0 : value;
}
export function list(value, name, maximum = 100000) {
  demand(Array.isArray(value) && value.length <= maximum, 'list', `${name} must be a bounded list`);
  return value;
}
export function select(value, options, name) {
  demand(options.includes(value), 'choice', `${name} is unsupported`, {options});
  return value;
}
export function distinct(values, name) {
  demand(new Set(values).size === values.length, 'duplicate', `${name} contains duplicates`);
  return values;
}
export function instant(value, name = 'time') {
  const raw = label(value, name, 40);
  demand(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:[.][0-9]{1,3})?Z$/.test(raw),
    'time', `${name} requires UTC ISO8601`);
  const parsed = Date.parse(raw);
  demand(Number.isFinite(parsed), 'time', `${name} cannot be parsed`);
  const normalized = new Date(parsed).toISOString();
  demand(normalized.slice(0, 19) === raw.slice(0, 19), 'time', `${name} is not a real calendar time`);
  return normalized;
}
export function encode(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    finite(value, 'JSON number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(encode).join(',')}]`;
  }
  dictionary(value);
  return `{${Object.keys(value).sort().map(name => `${JSON.stringify(name)}:${encode(value[name])}`).join(',')}}`;
}
export function checksum(value) {
  return createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : encode(value)).digest('hex');
}
export function token(value, secret, scope) {
  return createHmac('sha256', secret).update(encode([scope, value])).digest('hex');
}
export function decode(value) {
  try {
    const data = JSON.parse(value);
    encode(data);
    return data;
  } catch (error) {
    throw new HarborError('json', 'Input is not valid finite JSON', {cause: error.message});
  }
}
export function versionKey(dataset, version) {
  return `${key(dataset)}:${count(version, 'version', 1)}`;
}
export function splitVersion(value) {
  demand(typeof value === 'string', 'version', 'Version reference must be text');
  const parts = value.split(':');
  demand(parts.length === 2 && /^[1-9][0-9]*$/.test(parts[1]), 'version', 'Use dataset:version reference');
  return {dataset: key(parts[0]), version: count(Number(parts[1]), 'version', 1)};
}
export function found(record, id, kind) {
  demand(Object.hasOwn(record, id), 'missing', `${kind} does not exist`, {id}, 404);
  return record[id];
}
export function utcNow(clock = () => new Date()) {
  return instant(clock().toISOString());
}
export function changed(expected, actual) {
  demand(expected === undefined || expected === actual, 'stale', 'State changed since preview', {actual}, 409);
}
