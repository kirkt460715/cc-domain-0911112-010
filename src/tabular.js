import {demand, decode, encode, fields, key, list, select, finite, count} from './primitives.js';
const NEWLINE = String.fromCharCode(10);
const RETURN = String.fromCharCode(13);
const QUOTE = String.fromCharCode(34);

export function csvTable(content, separator = ',') {
  demand(typeof content === 'string', 'csv', 'CSV content must be text');
  demand([',', ';', String.fromCharCode(9)].includes(separator), 'separator', 'Unsupported separator');
  const cells = [];
  let currentRow = [];
  let current = '';
  let state = 'start';
  let offset = content.charCodeAt(0) === 0xfeff ? 1 : 0;
  function cell() {
    currentRow.push(current);
    current = '';
    state = 'start';
  }
  function row() {
    cell();
    cells.push(currentRow);
    currentRow = [];
    demand(cells.length <= 100001, 'table_limit', 'CSV row limit exceeded');
  }
  for (; offset < content.length; offset += 1) {
    const character = content[offset];
    if (state === 'quoted') {
      if (character === QUOTE) {
        if (content[offset + 1] === QUOTE) {
          current += QUOTE;
          offset += 1;
        } else {
          state = 'closed';
        }
      } else {
        current += character;
      }
    } else if (character === separator) {
      cell();
    } else if (character === NEWLINE || character === RETURN) {
      if (character === RETURN && content[offset + 1] === NEWLINE) {
        offset += 1;
      }
      row();
    } else if (character === QUOTE && state === 'start') {
      state = 'quoted';
    } else {
      demand(state !== 'closed' && character !== QUOTE, 'csv_quote', 'CSV quoting is malformed');
      current += character;
      state = 'plain';
    }
    demand(current.length <= 100000, 'cell_limit', 'CSV cell is too large');
  }
  demand(state !== 'quoted', 'csv_quote', 'CSV quoted field is incomplete');
  if (currentRow.length || current || state !== 'start') {
    row();
  }
  demand(cells.length > 0, 'csv_empty', 'CSV header is missing');
  const columns = cells.shift();
  demand(new Set(columns).size === columns.length, 'csv_header', 'Duplicate CSV columns');
  columns.forEach(column => key(column, 'column'));
  return cells.map((values, index) => {
    demand(values.length === columns.length, 'csv_width', 'CSV row width differs', {line: index + 2});
    return Object.fromEntries(columns.map((column, position) => [column, values[position]]));
  });
}
export function parseTable(content, format, options = {}) {
  select(format, ['csv', 'json', 'jsonl'], 'format');
  if (format === 'csv') {
    return csvTable(content, options.separator);
  }
  if (format === 'json') {
    return list(decode(content), 'table');
  }
  const rows = [];
  for (const line of content.split(NEWLINE)) {
    if (line.trim()) {
      rows.push(decode(line));
      demand(rows.length <= 100000, 'table_limit', 'JSONL row limit exceeded');
    }
  }
  return rows;
}
export function writeTable(rows, columns, format = 'jsonl') {
  select(format, ['jsonl', 'csv', 'json'], 'format');
  if (format === 'json') {
    return encode(rows);
  }
  if (format === 'jsonl') {
    return rows.map(encode).join(NEWLINE) + (rows.length ? NEWLINE : '');
  }
  function quote(value) {
    let text = value === null || value === undefined ? '' : String(value);
    if (typeof value === 'string' && /^[=+@-]/.test(text)) {
      text = String.fromCharCode(39) + text;
    }
    if ([QUOTE, NEWLINE, RETURN, ','].some(character => text.includes(character))) {
      return QUOTE + text.split(QUOTE).join(QUOTE + QUOTE) + QUOTE;
    }
    return text;
  }
  const lines = [columns.map(quote).join(',')];
  for (const row of rows) {
    lines.push(columns.map(column => quote(row[column])).join(','));
  }
  return lines.join(NEWLINE) + NEWLINE;
}
export function normalizeMapping(input, targetColumns) {
  const mapping = list(input ?? [], 'mapping', 200);
  const destinations = new Set();
  return mapping.map(rule => {
    fields(rule, ['target', 'source', 'default', 'operations'], ['target']);
    const target = key(rule.target);
    demand(targetColumns.includes(target), 'mapping_target', 'Unknown target column', {target});
    demand(!destinations.has(target), 'mapping_duplicate', 'Target mapped more than once');
    destinations.add(target);
    demand(rule.source !== undefined || Object.hasOwn(rule, 'default'), 'mapping_source', 'Mapping needs a source or default');
    if (rule.source !== undefined) {
      key(rule.source);
    }
    const operations = list(rule.operations ?? [], 'operations', 10);
    for (const operation of operations) {
      fields(operation, ['kind', 'value', 'values'], ['kind']);
      select(operation.kind, ['trim', 'lower', 'upper', 'scale', 'offset', 'replace', 'null_if'], 'operation');
      if (['scale', 'offset'].includes(operation.kind)) {
        finite(operation.value, 'operation value');
      }
      if (['replace', 'null_if'].includes(operation.kind)) {
        demand(operation.values !== undefined, 'operation', 'Lookup operation needs values');
      }
    }
    return {...rule, operations};
  });
}
export function transformRows(rows, mapping, columns) {
  if (!mapping.length) {
    return structuredClone(rows);
  }
  return rows.map((row, index) => {
    const result = {};
    for (const column of columns) {
      const rule = mapping.find(item => item.target === column);
      if (!rule) {
        result[column] = row[column] ?? null;
        continue;
      }
      let value = rule.source && Object.hasOwn(row, rule.source) ? row[rule.source] : rule.default ?? null;
      for (const operation of rule.operations) {
        if (value === null || value === undefined) {
          break;
        }
        switch (operation.kind) {
          case 'trim':
          case 'lower':
          case 'upper':
            demand(typeof value === 'string', 'transform_type', 'Text operation received non-text', {index, column});
            value = operation.kind === 'trim' ? value.trim() : operation.kind === 'lower' ? value.toLowerCase() : value.toUpperCase();
            break;
          case 'scale':
          case 'offset': {
            demand(typeof value === 'number' || typeof value === 'string' && value.trim() !== '',
              'transform_type', 'Numeric operation received empty or non-scalar value');
            const numeric = typeof value === 'number' ? value : Number(value);
            finite(numeric, 'transform input');
            value = operation.kind === 'scale' ? numeric * operation.value : numeric + operation.value;
            finite(value, 'transform output');
            break;
          }
          case 'replace':
            if (Object.hasOwn(operation.values, String(value))) {
              value = operation.values[String(value)];
            }
            break;
          case 'null_if':
            demand(Array.isArray(operation.values), 'transform_values', 'null_if values must be a list');
            if (operation.values.includes(value)) {
              value = null;
            }
            break;
        }
      }
      result[column] = value;
    }
    return result;
  });
}
export function sortRows(rows, columns) {
  return [...rows].sort((left, right) => {
    for (const column of columns) {
      if (left[column] === right[column]) {
        continue;
      }
      if (left[column] === null) {
        return -1;
      }
      if (right[column] === null) {
        return 1;
      }
      return left[column] < right[column] ? -1 : 1;
    }
    return 0;
  });
}
