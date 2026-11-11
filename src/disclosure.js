import {demand, fields, key, list, distinct, select, encode, checksum, token, finite, count} from './primitives.js';

import {castCell} from './schema.js';

export function filterSpec(input, schema) {
  return list(input ?? [], 'filters', 20).map(filter => {
    fields(filter, ['column', 'operator', 'value'], ['column', 'operator']);
    const column = key(filter.column);
    const definition = schema.columns.find(item => item.name === column);
    demand(definition, 'filter_column', 'Filter column does not exist');
    const operator = select(filter.operator, ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'in', 'is_null'], 'filter operator');
    if (operator === 'in') {
      list(filter.value, 'filter values', 100);
    } else if (operator !== 'is_null') {
      demand(Object.hasOwn(filter, 'value'), 'filter_value', 'Filter value is required');
    }
    if (operator === 'is_null') {
      return {column, operator};
    }
    const value = operator === 'in' ? filter.value.map(item => castCell(item, definition)) : castCell(filter.value, definition);
    encode(value);
    return {column, operator, value};
  });
}
export function matches(row, filters) {
  return filters.every(filter => {
    const value = row[filter.column];
    if (filter.operator === 'is_null') {
      return value === null;
    }
    if (filter.operator === 'eq') {
      return value === filter.value;
    }
    if (filter.operator === 'ne') {
      return value !== filter.value;
    }
    if (filter.operator === 'in') {
      return filter.value.includes(value);
    }
    if (value === null || filter.value === null) {
      return false;
    }
    switch (filter.operator) {
      case 'lt':
        return value < filter.value;
      case 'lte':
        return value <= filter.value;
      case 'gt':
        return value > filter.value;
      case 'gte':
        return value >= filter.value;
      default:
        return false;
    }
  });
}
export function protectValue(value, action, secret, scope) {
  if (action.kind === 'redact' || value === null) {
    return null;
  }
  switch (action.kind) {
    case 'keep':
      return value;
    case 'tokenize':
      return token(value, secret, scope);
    case 'bucket':
      return Math.floor(value / action.width) * action.width;
    case 'prefix':
      return [...value].slice(0, action.length).join('');
    case 'date_floor':
      return action.unit === 'year' ? value.slice(0, 4) + '-01-01' : value.slice(0, 7) + '-01';
    default:
      demand(false, 'transform', 'Unknown disclosure transform');
  }
}
export function buildDisclosure(rows, version, grant, request, secret) {
  const filters = filterSpec(request.filters, version.schema);
  for (const filter of filters) {
    const action = grant.transforms[filter.column] ?? {kind: 'keep'};
    demand(request.columns.includes(filter.column) && action.kind === 'keep',
      'filter_disclosure', 'Filters may only use released, untransformed columns');
  }
  const selected = rows.filter(row => matches(row, filters));
  const projected = selected.map(row => Object.fromEntries(request.columns.map(column => [column,
    protectValue(row[column], grant.transforms[column] ?? {kind: 'keep'}, secret,
      `${grant.recipient}:${grant.dataset}:${column}`)])));
  const groups = new Map();
  for (const row of projected) {
    const identity = encode(grant.quasiIdentifiers.map(column => row[column]));
    if (!groups.has(identity)) {
      groups.set(identity, []);
    }
    groups.get(identity).push(row);
  }
  const output = [];
  const histogram = {};
  let suppressed = 0;
  for (const group of groups.values()) {
    histogram[group.length] = (histogram[group.length] ?? 0) + 1;
    if (group.length < grant.minimumGroup) {
      suppressed += group.length;
    } else {
      output.push(...group);
    }
  }
  output.sort((a, b) => encode(a).localeCompare(encode(b)));
  return {
    rows: output,
    report: {inputRows: rows.length, selectedRows: selected.length, outputRows: output.length,
      suppressedRows: suppressed, groups: groups.size, groupSizeHistogram: histogram,
      minimumGroup: grant.minimumGroup, columns: request.columns},
    fingerprint: checksum(output),
    filters,
  };
}
export function disclosureRisk(rows, columns, quasiIdentifiers) {
  distinct(list(columns, 'columns'), 'columns');
  demand(quasiIdentifiers.every(column => columns.includes(column)), 'quasi', 'Unknown quasi identifier');
  const groups = new Map();
  for (const row of rows) {
    const value = encode(quasiIdentifiers.map(column => row[column]));
    groups.set(value, (groups.get(value) ?? 0) + 1);
  }
  const sizes = [...groups.values()];
  return {
    rows: rows.length,
    groups: groups.size,
    smallestGroup: sizes.length ? Math.min(...sizes) : null,
    uniqueRows: sizes.filter(size => size === 1).length,
    maximumReidentificationFraction: sizes.length ? 1 / Math.min(...sizes) : null,
    groupSizes: sizes.sort((a, b) => a - b),
  };
}
