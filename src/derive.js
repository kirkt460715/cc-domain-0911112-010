import {fields, key, list, distinct, select, found, demand, encode, checksum, count} from './primitives.js';
import {requireSteward, usableVersion} from './registry.js';
import {importVersion} from './importer.js';
import {CLASSIFICATIONS} from './schema.js';

function highestClass(columns) {
  const rank = Math.max(0, ...columns.map(column => CLASSIFICATIONS.indexOf(column.classification)));
  return CLASSIFICATIONS[rank];
}
function compatibleColumn(target, source) {
  demand(target.type === source.type || target.type === 'number' && source.type === 'integer',
    'derive_type', 'Derived column type is incompatible', {column: target.name});
  demand(CLASSIFICATIONS.indexOf(target.classification) >= CLASSIFICATIONS.indexOf(source.classification),
    'derive_classification', 'Derivation cannot lower inherited classification', {column: target.name});
}
export async function prepareDerivation(vault, index, input, actor) {
  fields(input, ['dataset', 'importId', 'left', 'join', 'projection', 'groupBy', 'aggregates'],
    ['dataset', 'importId', 'left', 'projection']);
  const target = found(index.datasets, key(input.dataset), 'Target dataset');
  requireSteward(index, target.owner, actor);
  const left = usableVersion(index, input.left);
  const leftDataset = index.datasets[left.dataset];
  demand(leftDataset.owner === target.owner && left.dataset !== target.id,
    'derive_owner', 'Derivation sources must be other datasets owned by the same organization');
  const dependencies = [left.reference];
  const sourceColumns = new Map(left.schema.columns.map(column => [`left.${column.name}`, column]));
  let combined = (await vault.getRows(left.object)).map(row => ({left: row, right: null}));
  let unmatched = 0;
  if (input.join) {
    fields(input.join, ['reference', 'leftColumns', 'rightColumns', 'mode'], ['reference', 'leftColumns', 'rightColumns']);
    const right = usableVersion(index, input.join.reference);
    const rightDataset = index.datasets[right.dataset];
    demand(rightDataset.owner === target.owner && right.dataset !== target.id, 'derive_owner', 'Join owner differs');
    const leftColumns = distinct(list(input.join.leftColumns, 'leftColumns', 10).map(value => key(value)), 'leftColumns');
    const rightColumns = distinct(list(input.join.rightColumns, 'rightColumns', 10).map(value => key(value)), 'rightColumns');
    demand(leftColumns.length > 0 && leftColumns.length === rightColumns.length, 'join_arity', 'Join key arity differs');
    demand(encode(rightColumns) === encode(right.schema.primaryKey), 'join_unique', 'Right join key must be the full primary key');
    for (let position = 0; position < leftColumns.length; position += 1) {
      const a = left.schema.columns.find(column => column.name === leftColumns[position]);
      const b = right.schema.columns.find(column => column.name === rightColumns[position]);
      demand(a && b && a.type === b.type, 'join_type', 'Join column types differ');
    }
    const mode = select(input.join.mode ?? 'inner', ['inner', 'left'], 'join mode');
    const lookup = new Map((await vault.getRows(right.object)).map(row => [encode(rightColumns.map(column => row[column])), row]));
    combined = combined.flatMap(entry => {
      const values = leftColumns.map(column => entry.left[column]);
      const match = values.some(value => value === null) ? null : lookup.get(encode(values)) ?? null;
      if (!match) {
        unmatched += 1;
      }
      return match || mode === 'left' ? [{left: entry.left, right: match}] : [];
    });
    for (const column of right.schema.columns) {
      sourceColumns.set(`right.${column.name}`, column);
    }
    dependencies.push(right.reference);
  }
  const projection = list(input.projection, 'projection', 200);
  distinct(projection.map(item => item.target), 'projection targets');
  const projectedColumns = new Map();
  for (const item of projection) {
    fields(item, ['target', 'source'], ['target', 'source']);
    key(item.target);
    demand(sourceColumns.has(item.source), 'projection_source', 'Projection names an unknown source column');
    projectedColumns.set(item.target, sourceColumns.get(item.source));
  }
  let rows = combined.map(entry => Object.fromEntries(projection.map(item => {
    const [side, column] = item.source.split('.');
    return [item.target, entry[side]?.[column] ?? null];
  })));
  const aggregates = list(input.aggregates ?? [], 'aggregates', 100);
  const groupBy = distinct(list(input.groupBy ?? [], 'groupBy', 20).map(value => key(value)), 'groupBy');
  if (aggregates.length) {
    demand(groupBy.every(column => projectedColumns.has(column)), 'group_column', 'Group column is absent from projection');
    const outputs = new Map(groupBy.map(column => [column, projectedColumns.get(column)]));
    for (const aggregate of aggregates) {
      fields(aggregate, ['target', 'operation', 'source'], ['target', 'operation']);
      key(aggregate.target);
      demand(!outputs.has(aggregate.target), 'aggregate_duplicate', 'Aggregate output is repeated');
      select(aggregate.operation, ['count', 'sum', 'mean', 'min', 'max'], 'aggregate');
      if (aggregate.operation === 'count') {
        outputs.set(aggregate.target, {type: 'integer', classification: highestClass([...projectedColumns.values()])});
      } else {
        const source = projectedColumns.get(aggregate.source);
        demand(source && ['integer', 'number'].includes(source.type), 'aggregate_type', 'Aggregate needs numeric source');
        outputs.set(aggregate.target, {type: aggregate.operation === 'mean' ? 'number' : source.type, classification: source.classification});
      }
    }
    const grouped = new Map();
    for (const row of rows) {
      const identity = encode(groupBy.map(column => row[column]));
      if (!grouped.has(identity)) {
        grouped.set(identity, []);
      }
      grouped.get(identity).push(row);
    }
    rows = [];
    for (const group of grouped.values()) {
      const output = Object.fromEntries(groupBy.map(column => [column, group[0][column]]));
      for (const aggregate of aggregates) {
        if (aggregate.operation === 'count') {
          output[aggregate.target] = group.length;
          continue;
        }
        const values = group.map(row => row[aggregate.source]).filter(value => value !== null);
        let value = null;
        if (values.length) {
          if (aggregate.operation === 'min') {
            value = values.reduce((a, b) => Math.min(a, b));
          } else if (aggregate.operation === 'max') {
            value = values.reduce((a, b) => Math.max(a, b));
          } else {
            let sum = 0;
            let compensation = 0;
            for (const number of values) {
              const adjusted = number - compensation;
              const next = sum + adjusted;
              compensation = (next - sum) - adjusted;
              sum = next;
            }
            value = aggregate.operation === 'mean' ? sum / values.length : sum;
          }
        }
        output[aggregate.target] = value;
      }
      rows.push(output);
    }
    projectedColumns.clear();
    for (const [name, definition] of outputs) {
      projectedColumns.set(name, definition);
    }
  } else {
    demand(groupBy.length === 0, 'group_without_aggregate', 'Group columns require aggregates');
  }
  demand(rows.length > 0, 'derive_empty', 'Derivation produced no rows');
  demand(target.schema.columns.length === projectedColumns.size, 'derive_columns', 'Derived outputs must exactly match target schema');
  for (const column of target.schema.columns) {
    const source = projectedColumns.get(column.name);
    demand(source, 'derive_columns', 'Target column has no derived source', {column: column.name});
    compatibleColumn(column, source);
  }
  return {target, rows, dependencies: [...new Set(dependencies)].sort(),
    report: {inputRows: left.rows, joinedRows: combined.length, unmatched, outputRows: rows.length, aggregated: aggregates.length > 0}};
}
export async function deriveVersion(vault, index, input, actor) {
  const fingerprint = checksum(input);
  const existing = Object.values(index.versions).find(version => version.dataset === input.dataset && version.importId === input.importId);
  if (existing) {
    demand(existing.recipeHash === fingerprint, 'derive_conflict', 'Derivation id already has a different recipe');
    return {noChange: true, result: {version: existing, replay: true}};
  }
  const prepared = await prepareDerivation(vault, index, input, actor);
  const outcome = await importVersion(vault, index, {dataset: input.dataset, importId: input.importId, rows: prepared.rows}, actor);
  const version = outcome.result.version;
  version.dependencies = [...new Set([...version.dependencies, ...prepared.dependencies])].sort();
  version.recipeHash = fingerprint;
  version.recipe = input;
  version.derivation = prepared.report;
  outcome.audit.recipeHash = fingerprint;
  return outcome;
}
