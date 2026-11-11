import {fields, key, label, list, demand, found, checksum, versionKey, decode} from './primitives.js';
import {normalizeMapping, transformRows, sortRows, parseTable} from './tabular.js';
import {validateTable, tableProfile, evaluateGate} from './quality.js';
import {requireSteward, usableVersion} from './registry.js';

export async function prepareVersion(vault, index, input, actor) {
  fields(input, ['dataset', 'importId', 'rows', 'content', 'format', 'mapping', 'references', 'coerce'],
    ['dataset', 'importId']);
  const dataset = found(index.datasets, key(input.dataset), 'Dataset');
  requireSteward(index, dataset.owner, actor);
  const importId = key(input.importId);
  demand((input.rows !== undefined) !== (input.content !== undefined), 'import_input', 'Supply rows or content, exclusively');
  const fingerprint = checksum(input);
  const previous = Object.values(index.versions).find(version => version.dataset === dataset.id && version.importId === importId);
  if (previous) {
    demand(previous.inputHash === fingerprint, 'import_conflict', 'Import id already has different input');
    return {replay: previous};
  }
  let rows;
  if (input.rows !== undefined) {
    rows = list(input.rows, 'rows');
  } else {
    demand(typeof input.content === 'string' && Buffer.byteLength(input.content) <= 32 * 1024 * 1024,
      'import_size', 'Import content exceeds limit');
    rows = parseTable(input.content, input.format);
  }
  demand(rows.length > 0, 'empty_import', 'Import contains no rows');
  const mapping = normalizeMapping(input.mapping, dataset.schema.columns.map(column => column.name));
  const transformed = transformRows(rows, mapping, dataset.schema.columns.map(column => column.name));
  const references = {};
  const dependencies = [];
  const supplied = input.references ?? {};
  for (const target of Object.keys(supplied)) {
    demand(dataset.schema.foreignKeys.some(foreign => foreign.target === target), 'reference_extra', 'Unneeded reference supplied');
  }
  for (const foreign of dataset.schema.foreignKeys) {
    if (references[foreign.target]) {
      continue;
    }
    const target = found(index.datasets, foreign.target, 'Reference dataset');
    const reference = supplied[foreign.target] ?? target.current;
    demand(reference, 'reference_missing', 'Reference dataset has no active version');
    const version = usableVersion(index, reference);
    demand(version.dataset === target.id, 'reference_dataset', 'Pinned reference belongs to another dataset');
    references[target.id] = {reference, rows: await vault.getRows(version.object)};
    dependencies.push(reference);
  }
  const coerce = input.coerce ?? input.format === 'csv';
  demand(typeof coerce === 'boolean', 'coerce', 'coerce must be boolean');
  const validated = validateTable(transformed, dataset.schema, references, {coerce});
  const sorted = sortRows(validated.rows, dataset.schema.primaryKey);
  const profile = tableProfile(sorted, dataset.schema);
  const gate = evaluateGate(validated.report, profile, dataset.gate);
  return {
    dataset,
    importId,
    fingerprint,
    raw: rows,
    rows: sorted,
    rejected: validated.rejected,
    report: validated.report,
    profile,
    gate,
    dependencies: dependencies.sort(),
    mapping,
  };
}
export async function importVersion(vault, index, input, actor) {
  const prepared = await prepareVersion(vault, index, input, actor);
  if (prepared.replay) {
    return {noChange: true, result: {version: prepared.replay, replay: true}};
  }
  const dataset = prepared.dataset;
  const raw = await vault.putObject(prepared.raw);
  const data = await vault.putObject(prepared.rows);
  const rejects = await vault.putObject(prepared.rejected);
  const number = dataset.nextVersion;
  const reference = versionKey(dataset.id, number);
  const record = {
    reference,
    dataset: dataset.id,
    version: number,
    importId: prepared.importId,
    inputHash: prepared.fingerprint,
    schema: structuredClone(dataset.schema),
    schemaHash: dataset.schemaHash,
    schemaRevision: dataset.schemaRevision,
    status: prepared.gate.passed ? 'validated' : 'quarantined',
    object: data.hash,
    rawObject: raw.hash,
    rejectedObject: rejects.hash,
    bytes: data.bytes,
    rows: prepared.rows.length,
    report: prepared.report,
    profile: prepared.profile,
    gate: prepared.gate,
    dependencies: prepared.dependencies,
    mapping: prepared.mapping,
    createdBy: actor,
    createdAt: new Date().toISOString(),
  };
  index.versions[reference] = record;
  dataset.nextVersion += 1;
  return {result: {version: record, replay: false}, audit: {reference, status: record.status, inputHash: record.inputHash}};
}
export async function importPreview(vault, index, input, actor) {
  const prepared = await prepareVersion(vault, index, input, actor);
  if (prepared.replay) {
    return {replay: true, version: prepared.replay.reference, generation: index.generation};
  }
  return {
    generation: index.generation,
    dataset: prepared.dataset.id,
    schemaHash: prepared.dataset.schemaHash,
    inputHash: prepared.fingerprint,
    report: prepared.report,
    profile: prepared.profile,
    gate: prepared.gate,
    dependencies: prepared.dependencies,
    rejected: prepared.rejected.map(({raw, ...issue}) => issue),
  };
}
export async function repairImport(vault, index, input, actor) {
  fields(input, ['reference', 'importId', 'replacements', 'discard'], ['reference', 'importId', 'replacements']);
  const original = found(index.versions, input.reference, 'Version');
  const dataset = found(index.datasets, original.dataset, 'Dataset');
  requireSteward(index, dataset.owner, actor);
  demand(original.status === 'quarantined', 'repair_state', 'Only quarantined imports can be repaired');
  demand(original.schemaHash === dataset.schemaHash, 'repair_schema', 'Schema changed; submit a new import explicitly');
  const raw = await vault.getRows(original.rawObject);
  const rejected = decode(await vault.getObject(original.rejectedObject));
  const rejectedIndexes = new Set(rejected.map(item => item.index));
  const replacements = list(input.replacements, 'replacements');
  const discard = new Set(list(input.discard ?? [], 'discard'));
  const touched = new Set();
  for (const replacement of replacements) {
    fields(replacement, ['index', 'row'], ['index', 'row']);
    demand(rejectedIndexes.has(replacement.index), 'repair_index', 'Only rejected rows can be replaced');
    demand(!touched.has(replacement.index) && !discard.has(replacement.index), 'repair_duplicate', 'Repair touches row twice');
    touched.add(replacement.index);
    raw[replacement.index] = replacement.row;
  }
  for (const position of discard) {
    demand(rejectedIndexes.has(position), 'repair_discard', 'Only rejected rows can be discarded');
  }
  demand(touched.size + discard.size > 0, 'repair_empty', 'Repair must change rejected rows');
  const rows = raw.filter((_, position) => !discard.has(position));
  const references = Object.fromEntries(original.dependencies.map(reference => [reference.split(':')[0], reference]));
  return importVersion(vault, index, {dataset: dataset.id, importId: input.importId, rows,
    mapping: original.mapping, references, coerce: true}, actor);
}
