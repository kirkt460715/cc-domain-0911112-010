import test from 'node:test';
import assert from 'node:assert/strict';
import {setup, schema, datasetInput, rows, kind} from './support.js';

test('typed import creates immutable normalized version and stable replay', async t => {
  const {harbor} = await setup(t, {imported: false});
  const input = {dataset: 'people', importId: 'one', rows: rows()};
  const imported = await harbor.import(input, 'alice');
  assert.equal(imported.version.status, 'validated');
  assert.equal(imported.version.rows, 3);
  assert.equal(imported.version.report.rejected, 0);
  const replay = await harbor.import(input, 'alice');
  assert.equal(replay.replay, true);
  assert.equal(replay.generation, imported.generation);
  assert.equal(replay.committed, false);
  assert.equal((await harbor.rows({reference: 'people:1'}, 'alice')).total, 3);
  await assert.rejects(harbor.rows({reference: 'people:1'}, 'carol'), kind('steward'));
  assert.equal((await harbor.verify()).valid, true);
});

test('duplicate primary keys and bad cells quarantine rows with separate reasons', async t => {
  const {harbor} = await setup(t, {imported: false});
  const input = [rows()[0], rows()[0], {...rows()[1], hours: -1}, {...rows()[2], district: 3}];
  const imported = await harbor.import({dataset: 'people', importId: 'bad', rows: input}, 'alice');
  assert.equal(imported.version.status, 'quarantined');
  assert.equal(imported.version.rows, 1);
  assert.equal(imported.version.report.rejected, 3);
  assert.equal(imported.version.report.issues.duplicate_key, 1);
  assert.equal(imported.version.report.issues.number, 1);
  assert.equal(imported.version.report.issues.cell_type, 1);
  const rejected = await harbor.rejected('people:1', 'alice');
  assert.deepEqual(rejected.rejected.map(issue => issue.index), [1, 2, 3]);
  assert.equal(rejected.rejected[0].context.firstRow, 0);
  await assert.rejects(harbor.activate({dataset: 'people', version: 1}, 'alice'), kind('version_state'));
});

test('quality gate can accept bounded rejects without losing quarantine evidence', async t => {
  const {harbor} = await setup(t, {imported: false, gate: {maximumRejectRate: 0.25, minimumRows: 3}});
  const imported = await harbor.import({dataset: 'people', importId: 'mixed', rows: [...rows(), {...rows()[0], hours: -1}]}, 'alice');
  assert.equal(imported.version.status, 'validated');
  assert.equal(imported.version.report.rejectionRate, 0.25);
  assert.equal(imported.version.gate.passed, true);
  assert.equal((await harbor.rejected('people:1', 'alice')).rejected.length, 1);
  await harbor.activate({dataset: 'people', version: 1}, 'alice');
  assert.equal((await harbor.catalog()).datasets[0].current, 'people:1');
  assert.equal((await harbor.verify()).valid, true);
});

test('row constraints and null distinctness gates reject unhealthy data', async t => {
  const {harbor} = await setup(t, {dataset: false});
  const definition = schema();
  definition.checks = [{left: 'hours', operator: 'lte', value: 20}];
  await harbor.dataset(datasetInput({schema: definition, gate: {maximumRejectRate: 1, minimumRows: 1,
    maxNullFractions: {note: 0}, minimumDistinct: {district: 2}}}), 'alice');
  const imported = await harbor.import({dataset: 'people', importId: 'one', rows: rows()}, 'alice');
  assert.equal(imported.version.report.issues.row_check, 1);
  assert.equal(imported.version.status, 'quarantined');
  const codes = imported.version.gate.failures.map(issue => issue.code);
  assert.ok(codes.includes('null_fraction'));
  assert.ok(codes.includes('distinct_count'));
  assert.equal(imported.version.profile.columns.note.nulls, 1);
});

test('CSV coercion is explicit while JSON numeric strings fail strict typing', async t => {
  const {harbor} = await setup(t, {imported: false});
  const csv = ['id,district,hours,note', 'a,delta,10,', 'b,delta,20,'].join(String.fromCharCode(10));
  const imported = await harbor.import({dataset: 'people', importId: 'csv', content: csv, format: 'csv'}, 'alice');
  assert.equal(imported.version.status, 'validated');
  const table = await harbor.rows({reference: 'people:1'}, 'alice');
  assert.equal(table.rows[0].hours, 10);
  assert.equal(typeof table.rows[0].hours, 'number');
  const strict = await harbor.import({dataset: 'people', importId: 'json', rows: [{...rows()[0], hours: '10'}]}, 'alice');
  assert.equal(strict.version.status, 'quarantined');
  assert.equal(strict.version.report.accepted, 0);
  const coerced = await harbor.import({dataset: 'people', importId: 'coerced', rows: [{...rows()[0], hours: '10'}], coerce: true}, 'alice');
  assert.equal(coerced.version.status, 'validated');
});

test('mapping preserves provenance and rejects invalid transform arithmetic', async t => {
  const {harbor} = await setup(t, {imported: false});
  const input = {dataset: 'people', importId: 'mapped', rows: [{person: 'a', area: ' DELTA ', minutes: 120}], mapping: [
    {target: 'id', source: 'person'},
    {target: 'district', source: 'area', operations: [{kind: 'trim'}, {kind: 'lower'}]},
    {target: 'hours', source: 'minutes', operations: [{kind: 'scale', value: 1 / 60}]},
    {target: 'note', default: null},
  ]};
  const imported = await harbor.import(input, 'alice');
  assert.equal(imported.version.mapping.length, 4);
  const table = await harbor.rows({reference: 'people:1'}, 'alice');
  assert.deepEqual(table.rows[0], {id: 'a', district: 'delta', hours: 2, note: null});
  const changed = structuredClone(input);
  changed.importId = 'bad-mapping';
  changed.rows[0].minutes = 'not-a-number';
  await assert.rejects(harbor.import(changed, 'alice'), kind('number'));
  assert.equal((await harbor.catalog()).versions.length, 1);
});

test('import id conflict and stale preview cannot overwrite data', async t => {
  const {harbor} = await setup(t, {imported: false});
  const input = {dataset: 'people', importId: 'one', rows: rows()};
  const preview = await harbor.previewImport(input, 'alice');
  assert.equal(preview.report.accepted, 3);
  assert.equal((await harbor.catalog()).versions.length, 0);
  await harbor.import(input, 'alice', preview.generation);
  await assert.rejects(harbor.import({...input, rows: [rows()[0]]}, 'alice'), kind('import_conflict'));
  await assert.rejects(harbor.import({...input, importId: 'two'}, 'alice', preview.generation), kind('stale'));
  assert.equal((await harbor.catalog()).versions.length, 1);
  assert.equal((await harbor.rows({reference: 'people:1'}, 'alice')).total, 3);
});

test('repair creates a new version and retains original rejected input', async t => {
  const {harbor} = await setup(t, {imported: false});
  await harbor.import({dataset: 'people', importId: 'bad', rows: [rows()[0], {...rows()[1], hours: -4}]}, 'alice');
  const repaired = await harbor.repair({reference: 'people:1', importId: 'fixed',
    replacements: [{index: 1, row: rows()[1]}]}, 'alice');
  assert.equal(repaired.version.reference, 'people:2');
  assert.equal(repaired.version.status, 'validated');
  assert.equal(repaired.version.rows, 2);
  assert.equal((await harbor.rejected('people:1', 'alice')).rejected[0].raw.hours, -4);
  await assert.rejects(harbor.repair({reference: 'people:1', importId: 'invalid',
    replacements: [{index: 0, row: rows()[2]}]}, 'alice'), kind('repair_index'));
  assert.equal((await harbor.verify()).valid, true);
});

test('schema additions preserve old snapshots and reject unsafe changes', async t => {
  const {harbor} = await setup(t);
  const extended = schema();
  extended.columns.push({name: 'language', type: 'string', classification: 'public', nullable: true});
  const revision = await harbor.schema({dataset: 'people', schema: extended, expectedRevision: 1}, 'alice');
  assert.equal(revision.dataset.schemaRevision, 2);
  const imported = await harbor.import({dataset: 'people', importId: 'extended', rows: rows()}, 'alice');
  assert.equal(imported.version.schemaRevision, 2);
  assert.equal((await harbor.rows({reference: 'people:2'}, 'alice')).rows[0].language, null);
  assert.equal(Object.hasOwn((await harbor.rows({reference: 'people:1'}, 'alice')).rows[0], 'language'), false);
  const unsafe = structuredClone(extended);
  unsafe.columns[0].classification = 'public';
  await assert.rejects(harbor.schema({dataset: 'people', schema: unsafe, expectedRevision: 2}, 'alice'), kind('schema_incompatible'));
  await assert.rejects(harbor.schema({dataset: 'people', schema: extended, expectedRevision: 1}, 'alice'), kind('schema_stale'));
});

test('version activation uses compare-and-swap and keeps earlier active versions pinned', async t => {
  const {harbor} = await setup(t);
  await harbor.import({dataset: 'people', importId: 'two', rows: [rows()[0]]}, 'alice');
  await assert.rejects(harbor.activate({dataset: 'people', version: 2, expectedCurrent: null}, 'alice'), kind('activation_stale'));
  await harbor.activate({dataset: 'people', version: 2, expectedCurrent: 'people:1'}, 'alice');
  const catalog = await harbor.catalog();
  assert.equal(catalog.datasets[0].current, 'people:2');
  assert.equal(catalog.versions[0].status, 'active');
  assert.equal(catalog.versions[1].status, 'active');
  assert.equal((await harbor.activate({dataset: 'people', version: 2}, 'alice')).committed, false);
});
