import {fields, key, list, distinct, select, count, finite, label, demand, instant, encode} from './primitives.js';

export const CLASSIFICATIONS = ['public', 'internal', 'sensitive', 'restricted'];
export const TYPES = ['string', 'integer', 'number', 'boolean', 'date', 'timestamp', 'enum'];
export function columnSpec(input) {
  fields(input, ['name', 'type', 'nullable', 'classification', 'minimum', 'maximum', 'maxLength', 'values', 'trim', 'case'],
    ['name', 'type', 'classification']);
  const type = select(input.type, TYPES, 'type');
  const column = {
    name: key(input.name, 'column'),
    type,
    nullable: input.nullable ?? false,
    classification: select(input.classification, CLASSIFICATIONS, 'classification'),
    trim: input.trim ?? true,
    case: select(input.case ?? 'preserve', ['preserve', 'lower', 'upper'], 'case'),
  };
  demand(typeof column.nullable === 'boolean' && typeof column.trim === 'boolean', 'boolean', 'Column flags must be booleans');
  if (['integer', 'number'].includes(type)) {
    if (input.minimum !== undefined) {
      column.minimum = finite(input.minimum, 'minimum');
    }
    if (input.maximum !== undefined) {
      column.maximum = finite(input.maximum, 'maximum');
    }
    demand(column.minimum === undefined || column.maximum === undefined || column.minimum <= column.maximum,
      'bounds', 'Column numeric bounds are reversed');
  } else {
    demand(input.minimum === undefined && input.maximum === undefined, 'bounds', 'Only numeric columns have numeric bounds');
  }
  if (type === 'string' || type === 'enum') {
    column.maxLength = count(input.maxLength ?? 1024, 'maxLength', 1, 100000);
  } else {
    demand(input.maxLength === undefined, 'length', 'Only text columns have maxLength');
  }
  if (type === 'enum') {
    column.values = distinct(list(input.values, 'values', 1000).map(value => label(value, 'enum value')), 'values');
    demand(column.values.length > 0, 'enum', 'Enum requires values');
  } else {
    demand(input.values === undefined, 'enum', 'Only enum columns have values');
  }
  return column;
}
export function schemaSpec(input) {
  fields(input, ['columns', 'primaryKey', 'foreignKeys', 'checks'], ['columns', 'primaryKey']);
  const columns = list(input.columns, 'columns', 200).map(columnSpec);
  demand(columns.length > 0, 'columns', 'Schema needs columns');
  distinct(columns.map(column => column.name), 'columns');
  const names = new Set(columns.map(column => column.name));
  const primaryKey = distinct(list(input.primaryKey, 'primaryKey', 10).map(name => key(name)), 'primaryKey');
  demand(primaryKey.length > 0, 'primary_key', 'Primary key cannot be empty');
  for (const name of primaryKey) {
    demand(names.has(name), 'primary_key', 'Primary key column is absent', {name});
    demand(!columns.find(column => column.name === name).nullable, 'primary_key', 'Primary key cannot be nullable');
  }
  const foreignKeys = list(input.foreignKeys ?? [], 'foreignKeys', 20).map(reference => {
    fields(reference, ['columns', 'target', 'targetColumns'], ['columns', 'target', 'targetColumns']);
    const local = distinct(list(reference.columns, 'foreign key columns', 10).map(key), 'foreign key columns');
    const remote = distinct(list(reference.targetColumns, 'target columns', 10).map(key), 'target columns');
    demand(local.length > 0 && local.length === remote.length, 'foreign_key', 'Foreign key arity differs');
    demand(local.every(name => names.has(name)), 'foreign_key', 'Foreign key names unknown local column');
    return {columns: local, target: key(reference.target), targetColumns: remote};
  });
  const checks = list(input.checks ?? [], 'checks', 50).map(check => {
    fields(check, ['left', 'operator', 'right', 'value'], ['left', 'operator']);
    const left = key(check.left);
    demand(names.has(left), 'check', 'Check left column is absent');
    const operator = select(check.operator, ['eq', 'ne', 'lt', 'lte', 'gt', 'gte'], 'operator');
    demand((check.right !== undefined) !== (check.value !== undefined), 'check', 'Check needs exactly one right operand');
    if (check.right !== undefined) {
      demand(names.has(check.right), 'check', 'Check right column is absent');
      return {left, operator, right: check.right};
    }
    encode(check.value);
    return {left, operator, value: check.value};
  });
  return {columns, primaryKey, foreignKeys, checks};
}
export function castCell(value, column, {coerce = false} = {}) {
  if (value === null || value === undefined || coerce && value === '' && column.type !== 'string') {
    demand(column.nullable, 'null', 'Non-nullable column has no value', {column: column.name});
    return null;
  }
  switch (column.type) {
    case 'string':
    case 'enum': {
      demand(typeof value === 'string', 'cell_type', 'Expected text', {column: column.name});
      let result = value.normalize('NFC');
      if (column.trim) {
        result = result.trim();
      }
      if (column.case === 'lower') {
        result = result.toLowerCase();
      } else if (column.case === 'upper') {
        result = result.toUpperCase();
      }
      demand(result.length <= column.maxLength, 'cell_length', 'Text exceeds column length', {column: column.name});
      demand(!result.includes(String.fromCharCode(0)), 'cell_text', 'NUL character is forbidden');
      if (column.type === 'enum') {
        demand(column.values.includes(result), 'cell_enum', 'Value is outside enum', {column: column.name});
      }
      return result;
    }
    case 'integer':
    case 'number': {
      let converted = value;
      if (coerce && typeof value === 'string') {
        demand(/^[+-]?(?:[0-9]+(?:[.][0-9]*)?|[.][0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(value),
          'cell_number', 'Numeric text is malformed');
        converted = Number(value);
      }
      finite(converted, column.name, column.minimum ?? -Infinity, column.maximum ?? Infinity);
      if (column.type === 'integer') {
        demand(Number.isSafeInteger(converted), 'cell_integer', 'Integer is not safely representable');
      }
      return converted;
    }
    case 'boolean':
      if (coerce && ['true', 'false'].includes(value)) {
        return value === 'true';
      }
      demand(typeof value === 'boolean', 'cell_boolean', 'Boolean must be true or false');
      return value;
    case 'date': {
      demand(typeof value === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value),
        'cell_date', 'Date must use YYYY-MM-DD');
      instant(`${value}T00:00:00Z`);
      return value;
    }
    case 'timestamp':
      return instant(value, column.name);
    default:
      demand(false, 'cell_type', 'Unsupported column type');
  }
}
export function primaryValue(row, schema) {
  return encode(schema.primaryKey.map(column => row[column]));
}
export function compareSchemas(before, after) {
  const issues = [];
  const old = new Map(before.columns.map(column => [column.name, column]));
  for (const column of after.columns) {
    const previous = old.get(column.name);
    if (!previous) {
      if (!column.nullable) {
        issues.push({column: column.name, code: 'required_column_added'});
      }
      continue;
    }
    old.delete(column.name);
    if (column.type !== previous.type) {
      issues.push({column: column.name, code: 'type_changed'});
    }
    if (previous.nullable && !column.nullable) {
      issues.push({column: column.name, code: 'nullability_narrowed'});
    }
    if (CLASSIFICATIONS.indexOf(column.classification) < CLASSIFICATIONS.indexOf(previous.classification)) {
      issues.push({column: column.name, code: 'classification_lowered'});
    }
    if ((column.minimum ?? -Infinity) > (previous.minimum ?? -Infinity) ||
      (column.maximum ?? Infinity) < (previous.maximum ?? Infinity)) {
      issues.push({column: column.name, code: 'bounds_narrowed'});
    }
    if ((column.maxLength ?? Infinity) < (previous.maxLength ?? Infinity)) {
      issues.push({column: column.name, code: 'length_narrowed'});
    }
    if (column.case !== previous.case || column.trim !== previous.trim) {
      issues.push({column: column.name, code: 'normalization_changed'});
    }
    if (column.type === 'enum' && previous.values?.some(value => !column.values.includes(value))) {
      issues.push({column: column.name, code: 'enum_narrowed'});
    }
  }
  for (const column of old.keys()) {
    issues.push({column, code: 'column_removed'});
  }
  if (encode(before.primaryKey) !== encode(after.primaryKey)) {
    issues.push({code: 'primary_key_changed'});
  }
  return {compatible: issues.length === 0, issues};
}
