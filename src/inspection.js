import {fields, key, list, count, found, demand, checksum, encode, decode} from './primitives.js';
import {requireSteward} from './registry.js';
import {primaryValue} from './schema.js';
import {profileDrift} from './quality.js';
import {filterSpec, matches, disclosureRisk} from './disclosure.js';

export async function readVersion(vault, index, input, actor) {
  fields(input, ['reference', 'limit', 'cursor', 'filters', 'columns'], ['reference']);
  const version = found(index.versions, input.reference, 'Version');
  const dataset = index.datasets[version.dataset];
  requireSteward(index, dataset.owner, actor);
  const limit = count(input.limit ?? 100, 'limit', 1, 10000);
  const columns = input.columns ?? version.schema.columns.map(column => column.name);
  list(columns, 'columns', 200);
  demand(new Set(columns).size === columns.length && columns.every(name => version.schema.columns.some(column => column.name === name)),
    'query_columns', 'Unknown or repeated query column');
  const filters = filterSpec(input.filters, version.schema);
  const queryHash = checksum({reference: version.reference, object: version.object, filters, columns, limit});
  let offset = 0;
  if (input.cursor) {
    let cursor;
    try {
      cursor = decode(Buffer.from(input.cursor, 'base64url').toString());
    } catch {
      demand(false, 'cursor', 'Pagination cursor is malformed');
    }
    demand(cursor.hash === queryHash, 'cursor_query', 'Cursor belongs to another immutable query');
    offset = count(cursor.offset, 'offset', 0, version.rows);
  }
  const all = (await vault.getRows(version.object)).filter(row => matches(row, filters));
  const rows = all.slice(offset, offset + limit).map(row => Object.fromEntries(columns.map(column => [column, row[column]])));
  const nextOffset = offset + rows.length;
  const next = nextOffset < all.length ? Buffer.from(encode({hash: queryHash, offset: nextOffset})).toString('base64url') : null;
  return {reference: version.reference, status: version.status, total: all.length, rows, next, object: version.object};
}
export async function compareVersions(vault, index, input, actor) {
  fields(input, ['before', 'after', 'maximumDetails'], ['before', 'after']);
  const before = found(index.versions, input.before, 'Version');
  const after = found(index.versions, input.after, 'Version');
  demand(before.dataset === after.dataset, 'diff_dataset', 'Versions belong to different datasets');
  requireSteward(index, index.datasets[before.dataset].owner, actor);
  demand(encode(before.schema.primaryKey) === encode(after.schema.primaryKey), 'diff_key', 'Primary keys are incompatible');
  const maximum = count(input.maximumDetails ?? 100, 'maximumDetails', 0, 10000);
  const oldRows = new Map((await vault.getRows(before.object)).map(row => [primaryValue(row, before.schema), row]));
  const newRows = await vault.getRows(after.object);
  const details = [];
  const counts = {added: 0, removed: 0, changed: 0, equal: 0};
  for (const row of newRows) {
    const id = primaryValue(row, after.schema);
    const previous = oldRows.get(id);
    if (!previous) {
      counts.added += 1;
      if (details.length < maximum) {
        details.push({kind: 'added', key: id, after: row});
      }
      continue;
    }
    oldRows.delete(id);
    if (encode(previous) === encode(row)) {
      counts.equal += 1;
      continue;
    }
    counts.changed += 1;
    if (details.length < maximum) {
      const columns = [...new Set([...Object.keys(previous), ...Object.keys(row)])].filter(column =>
        encode(previous[column] ?? null) !== encode(row[column] ?? null));
      details.push({kind: 'changed', key: id, columns, before: previous, after: row});
    }
  }
  for (const [id, row] of oldRows) {
    counts.removed += 1;
    if (details.length < maximum) {
      details.push({kind: 'removed', key: id, before: row});
    }
  }
  return {before: before.reference, after: after.reference, counts, details,
    truncated: counts.added + counts.removed + counts.changed > details.length,
    drift: profileDrift(before.profile, after.profile)};
}
export async function rejectedRows(vault, index, reference, actor) {
  const version = found(index.versions, reference, 'Version');
  requireSteward(index, index.datasets[version.dataset].owner, actor);
  const rejected = decode(await vault.getObject(version.rejectedObject));
  return {reference, status: version.status, report: version.report, rejected};
}
export async function inspectRisk(vault, index, input, actor) {
  fields(input, ['reference', 'quasiIdentifiers'], ['reference', 'quasiIdentifiers']);
  const version = found(index.versions, input.reference, 'Version');
  requireSteward(index, index.datasets[version.dataset].owner, actor);
  const columns = version.schema.columns.map(column => column.name);
  const quasi = list(input.quasiIdentifiers, 'quasiIdentifiers', 20);
  demand(quasi.length > 0, 'quasi_required', 'At least one quasi identifier is required');
  return disclosureRisk(await vault.getRows(version.object), columns, quasi);
}
export function lineage(index, reference) {
  const version = found(index.versions, reference, 'Version');
  const ancestors = new Set();
  const descendents = new Set();
  const edges = [];
  function walk(current, trail) {
    demand(!trail.includes(current), 'lineage_cycle', 'Version dependency graph contains a cycle');
    for (const parent of found(index.versions, current, 'Version').dependencies) {
      edges.push({from: parent, to: current});
      if (!ancestors.has(parent)) {
        ancestors.add(parent);
        walk(parent, [...trail, current]);
      }
    }
  }
  walk(reference, []);
  const queue = [reference];
  while (queue.length) {
    const current = queue.shift();
    for (const item of Object.values(index.versions)) {
      if (item.dependencies.includes(current) && !descendents.has(item.reference)) {
        descendents.add(item.reference);
        queue.push(item.reference);
      }
    }
  }
  return {
    reference,
    schemaHash: version.schemaHash,
    object: version.object,
    ancestors: [...ancestors].sort(),
    descendents: [...descendents].sort(),
    edges,
    requests: Object.values(index.requests).filter(item => item.reference === reference)
      .map(item => ({id: item.id, status: item.status})),
    releases: Object.values(index.releases).filter(item => item.reference === reference)
      .map(item => ({id: item.id, status: item.status})),
  };
}
export function catalogSummary(index) {
  return {
    generation: index.generation,
    organizations: Object.values(index.organizations).map(item => ({id: item.id, region: item.region, enabled: item.enabled})),
    datasets: Object.values(index.datasets).map(item => ({id: item.id, owner: item.owner, current: item.current,
      schemaRevision: item.schemaRevision, versions: item.nextVersion - 1})),
    versions: Object.values(index.versions).map(item => ({reference: item.reference, status: item.status, rows: item.rows,
      rejected: item.report.rejected, dependencies: item.dependencies})),
  };
}
