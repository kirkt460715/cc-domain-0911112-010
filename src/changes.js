import {fields, key, list, found, demand, checksum, encode} from './primitives.js';
import {requireSteward, usableVersion} from './registry.js';
import {primaryValue, castCell} from './schema.js';
import {importVersion} from './importer.js';

export async function prepareChanges(vault, index, input, actor) {
  fields(input, ['dataset', 'base', 'importId', 'changes', 'expectedCurrent'],
    ['dataset', 'base', 'importId', 'changes', 'expectedCurrent']);
  const dataset = found(index.datasets, key(input.dataset), 'Dataset');
  requireSteward(index, dataset.owner, actor);
  demand(dataset.current === input.expectedCurrent, 'change_stale', 'Dataset current version changed');
  const base = usableVersion(index, input.base);
  demand(base.dataset === dataset.id, 'change_dataset', 'Base version belongs to another dataset');
  demand(base.schemaHash === dataset.schemaHash, 'change_schema', 'Base schema differs from current schema');
  const rows = await vault.getRows(base.object);
  const byKey = new Map(rows.map(row => [primaryValue(row, base.schema), row]));
  const touched = new Set();
  const result = {inserted: 0, updated: 0, deleted: 0};
  for (const change of list(input.changes, 'changes', 10000)) {
    fields(change, ['operation', 'key', 'row', 'expectedHash'], ['operation', 'key']);
    demand(['insert', 'update', 'delete'].includes(change.operation), 'change_operation', 'Unknown change operation');
    demand(Array.isArray(change.key) && change.key.length === base.schema.primaryKey.length,
      'change_key', 'Change key has incorrect arity');
    const values = change.key.map((value, position) => {
      const name = base.schema.primaryKey[position];
      return castCell(value, base.schema.columns.find(column => column.name === name));
    });
    const identity = encode(values);
    demand(!touched.has(identity), 'change_duplicate', 'Change set touches the same key more than once');
    touched.add(identity);
    const previous = byKey.get(identity);
    if (change.operation === 'insert') {
      demand(!previous, 'change_exists', 'Inserted key already exists');
      demand(change.expectedHash === undefined, 'change_hash', 'Insert cannot require an existing row hash');
    } else {
      demand(previous, 'change_missing', 'Changed key does not exist');
      demand(change.expectedHash === checksum(previous), 'change_conflict', 'Existing row differs from expected hash');
    }
    if (change.operation === 'delete') {
      demand(change.row === undefined, 'change_row', 'Delete cannot supply a replacement row');
      byKey.delete(identity);
      result.deleted += 1;
      continue;
    }
    demand(change.row && typeof change.row === 'object', 'change_row', 'Change requires a full replacement row');
    const normalizedKey = base.schema.primaryKey.map(name =>
      castCell(change.row[name], base.schema.columns.find(column => column.name === name)));
    demand(encode(normalizedKey) === identity, 'change_key_mismatch', 'Replacement changes its primary key');
    byKey.set(identity, change.row);
    result[change.operation === 'insert' ? 'inserted' : 'updated'] += 1;
  }
  demand(touched.size > 0, 'change_empty', 'Change set has no operations');
  return {rows: [...byKey.values()], result, dataset, base};
}
export async function applyChanges(vault, index, input, actor) {
  const existing = Object.values(index.versions).find(version =>
    version.dataset === input.dataset && version.importId === input.importId);
  const fingerprint = checksum(input);
  if (existing) {
    demand(existing.changeHash === fingerprint, 'change_replay', 'Change import id belongs to different operations');
    return {noChange: true, result: {version: existing, replay: true}};
  }
  const prepared = await prepareChanges(vault, index, input, actor);
  const references = Object.fromEntries(prepared.base.dependencies
    .filter(reference => reference.split(':')[0] !== prepared.dataset.id)
    .map(reference => [reference.split(':')[0], reference]));
  const imported = await importVersion(vault, index, {dataset: input.dataset, importId: input.importId,
    rows: prepared.rows, references}, actor);
  imported.result.version.changeHash = fingerprint;
  imported.result.version.changes = prepared.result;
  imported.result.version.dependencies = [...new Set([...imported.result.version.dependencies, input.base])].sort();
  imported.audit.changes = prepared.result;
  return imported;
}
export async function previewChanges(vault, index, input, actor) {
  const prepared = await prepareChanges(vault, index, input, actor);
  return {generation: index.generation, dataset: prepared.dataset.id, base: input.base,
    changes: prepared.result, resultingRows: prepared.rows.length, fingerprint: checksum(input)};
}
