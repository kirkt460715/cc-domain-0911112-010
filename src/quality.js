import {HarborError, demand, encode, fields, count, finite, checksum} from './primitives.js';
import {castCell, primaryValue} from './schema.js';

function comparison(left, operator, right) {
  switch (operator) {
    case 'eq':
      return left === right;
    case 'ne':
      return left !== right;
    case 'lt':
      return left < right;
    case 'lte':
      return left <= right;
    case 'gt':
      return left > right;
    case 'gte':
      return left >= right;
    default:
      return false;
  }
}
export function validateTable(rows, schema, references = {}, options = {}) {
  const valid = [];
  const rejected = [];
  const keys = new Map();
  const names = new Set(schema.columns.map(column => column.name));
  const referenceSets = new Map();
  for (const foreign of schema.foreignKeys) {
    const table = references[foreign.target];
    demand(table, 'reference_missing', 'Required reference dataset is absent', {dataset: foreign.target});
    const set = new Set(table.rows.map(row => encode(foreign.targetColumns.map(column => row[column]))));
    referenceSets.set(encode(foreign), set);
  }
  for (let index = 0; index < rows.length; index += 1) {
    const input = rows[index];
    try {
      demand(input && typeof input === 'object' && !Array.isArray(input), 'row_shape', 'Row is not an object');
      for (const name of Object.keys(input)) {
        demand(names.has(name), 'unknown_column', 'Row contains an unknown column', {column: name});
      }
      const normalized = {};
      for (const column of schema.columns) {
        normalized[column.name] = castCell(input[column.name], column, options);
      }
      const identity = primaryValue(normalized, schema);
      demand(!keys.has(identity), 'duplicate_key', 'Primary key occurs more than once', {firstRow: keys.get(identity) ?? null});
      for (const foreign of schema.foreignKeys) {
        const values = foreign.columns.map(column => normalized[column]);
        if (values.every(value => value === null)) {
          continue;
        }
        demand(values.every(value => value !== null), 'partial_foreign_key', 'Composite foreign key is partially null');
        demand(referenceSets.get(encode(foreign)).has(encode(values)), 'foreign_key', 'Referenced row does not exist',
          {dataset: foreign.target});
      }
      for (const check of schema.checks) {
        const left = normalized[check.left];
        const right = check.right ? normalized[check.right] : check.value;
        if (left === null || right === null) {
          continue;
        }
        demand(comparison(left, check.operator, right), 'row_check', 'Row comparison failed',
          {left: check.left, operator: check.operator, right: check.right ?? null});
      }
      keys.set(identity, index);
      valid.push({index, row: normalized});
    } catch (error) {
      if (!(error instanceof HarborError)) {
        throw error;
      }
      rejected.push({index, code: error.kind, message: error.message, context: error.context, raw: input});
    }
  }
  const issues = {};
  for (const rejection of rejected) {
    issues[rejection.code] = (issues[rejection.code] ?? 0) + 1;
  }
  return {
    rows: valid.map(item => item.row),
    rowIndexes: valid.map(item => item.index),
    rejected,
    report: {submitted: rows.length, accepted: valid.length, rejected: rejected.length,
      rejectionRate: rows.length ? rejected.length / rows.length : 0, issues},
  };
}
export function tableProfile(rows, schema) {
  const columns = {};
  for (const column of schema.columns) {
    const values = rows.map(row => row[column.name]);
    const present = values.filter(value => value !== null);
    const unique = new Set(present.map(encode));
    const profile = {
      type: column.type,
      classification: column.classification,
      count: values.length,
      nulls: values.length - present.length,
      distinct: unique.size,
    };
    if (['integer', 'number'].includes(column.type) && present.length) {
      let mean = 0;
      let m2 = 0;
      let minimum = Infinity;
      let maximum = -Infinity;
      for (let index = 0; index < present.length; index += 1) {
        const value = present[index];
        const delta = value - mean;
        mean += delta / (index + 1);
        m2 += delta * (value - mean);
        minimum = Math.min(minimum, value);
        maximum = Math.max(maximum, value);
      }
      Object.assign(profile, {minimum, maximum, mean, variance: m2 / present.length});
    }
    if (['string', 'enum'].includes(column.type)) {
      profile.maximumLength = present.reduce((maximum, value) => Math.max(maximum, value.length), 0);
      profile.empty = present.filter(value => value === '').length;
    }
    columns[column.name] = profile;
  }
  return {rows: rows.length, columns};
}
export function gateSpec(input = {}) {
  fields(input, ['minimumRows', 'maximumRejectRate', 'maxNullFractions', 'minimumDistinct'], []);
  const maxNullFractions = input.maxNullFractions ?? {};
  const minimumDistinct = input.minimumDistinct ?? {};
  for (const [column, value] of Object.entries(maxNullFractions)) {
    finite(value, `maxNullFractions.${column}`, 0, 1);
  }
  for (const [column, value] of Object.entries(minimumDistinct)) {
    count(value, `minimumDistinct.${column}`, 0, 100000);
  }
  return {
    minimumRows: count(input.minimumRows ?? 1, 'minimumRows', 0, 100000),
    maximumRejectRate: finite(input.maximumRejectRate ?? 0, 'maximumRejectRate', 0, 1),
    maxNullFractions,
    minimumDistinct,
  };
}
export function evaluateGate(validation, profile, gate) {
  const failures = [];
  if (validation.accepted < gate.minimumRows) {
    failures.push({code: 'minimum_rows', actual: validation.accepted, required: gate.minimumRows});
  }
  if (validation.rejectionRate > gate.maximumRejectRate) {
    failures.push({code: 'rejection_rate', actual: validation.rejectionRate, maximum: gate.maximumRejectRate});
  }
  for (const [name, maximum] of Object.entries(gate.maxNullFractions)) {
    demand(profile.columns[name], 'gate_column', 'Gate references unknown column', {name});
    const column = profile.columns[name];
    const actual = column.count ? column.nulls / column.count : 0;
    if (actual > maximum) {
      failures.push({code: 'null_fraction', column: name, actual, maximum});
    }
  }
  for (const [name, minimum] of Object.entries(gate.minimumDistinct)) {
    demand(profile.columns[name], 'gate_column', 'Gate references unknown column', {name});
    const actual = profile.columns[name].distinct;
    if (actual < minimum) {
      failures.push({code: 'distinct_count', column: name, actual, minimum});
    }
  }
  return {passed: failures.length === 0, failures};
}
export function profileDrift(before, after) {
  const drift = [];
  for (const [name, current] of Object.entries(after.columns)) {
    const previous = before.columns[name];
    if (!previous) {
      drift.push({column: name, kind: 'added'});
      continue;
    }
    const priorNullRate = previous.count ? previous.nulls / previous.count : 0;
    const currentNullRate = current.count ? current.nulls / current.count : 0;
    const entry = {column: name, nullRateChange: currentNullRate - priorNullRate,
      distinctChange: current.distinct - previous.distinct};
    if (previous.mean !== undefined && current.mean !== undefined) {
      entry.meanChange = current.mean - previous.mean;
      entry.standardizedShift = previous.variance > 0 ? entry.meanChange / Math.sqrt(previous.variance) : null;
    }
    drift.push(entry);
  }
  for (const name of Object.keys(before.columns)) {
    if (!after.columns[name]) {
      drift.push({column: name, kind: 'removed'});
    }
  }
  return {rowChange: after.rows - before.rows, columns: drift};
}
