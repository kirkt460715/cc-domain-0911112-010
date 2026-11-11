import test from 'node:test';
import assert from 'node:assert/strict';
import {setup, datasetInput, schema, rows, grant, request, approved, kind} from './support.js';
import {checksum} from '../src/primitives.js';

async function addDistricts(harbor) {
  await harbor.dataset({id: 'districts', name: 'Synthetic districts', owner: 'owner', schema: {
    columns: [{name: 'code', type: 'string', classification: 'public'},
      {name: 'name', type: 'string', classification: 'public'}], primaryKey: ['code']}}, 'alice');
  await harbor.import({dataset: 'districts', importId: 'one', rows: [
    {code: 'delta', name: 'Synthetic delta'}, {code: 'hill', name: 'Synthetic hill'}]}, 'alice');
  await harbor.activate({dataset: 'districts', version: 1}, 'alice');
}

test('foreign keys pin concrete reference versions and quarantine missing parents', async t => {
  const {harbor} = await setup(t, {dataset: false});
  await addDistricts(harbor);
  const definition = schema();
  definition.foreignKeys = [{columns: ['district'], target: 'districts', targetColumns: ['code']}];
  await harbor.dataset(datasetInput({schema: definition}), 'alice');
  const imported = await harbor.import({dataset: 'people', importId: 'one', rows: [
    ...rows(), {id: 'd', district: 'unknown', hours: 3, note: null}]}, 'alice');
  assert.equal(imported.version.status, 'quarantined');
  assert.equal(imported.version.report.issues.foreign_key, 1);
  assert.deepEqual(imported.version.dependencies, ['districts:1']);
  assert.equal(imported.version.rows, 3);
  const fixed = await harbor.repair({reference: 'people:1', importId: 'fixed', replacements: [], discard: [3]}, 'alice');
  assert.equal(fixed.version.status, 'validated');
  await harbor.activate({dataset: 'people', version: 2}, 'alice');
  assert.equal((await harbor.lineage('people:2', 'alice')).ancestors[0], 'districts:1');
});

test('retirement previews transitive impact and cascades releases and requests', async t => {
  const {harbor} = await setup(t, {dataset: false});
  await addDistricts(harbor);
  const definition = schema();
  definition.foreignKeys = [{columns: ['district'], target: 'districts', targetColumns: ['code']}];
  await harbor.dataset(datasetInput({schema: definition}), 'alice');
  await harbor.import({dataset: 'people', importId: 'one', rows: rows()}, 'alice');
  await harbor.activate({dataset: 'people', version: 1}, 'alice');
  await approved(harbor);
  await harbor.release({id: 'r', request: 'q'}, 'alice');
  await harbor.request(request({id: 'q2'}), 'carol');
  const impact = await harbor.retirementImpact('districts:1', 'alice');
  assert.deepEqual(impact.versions, ['districts:1', 'people:1']);
  assert.deepEqual(impact.releases, ['r']);
  assert.deepEqual(impact.requests, ['q2']);
  await assert.rejects(harbor.retire({reference: 'districts:1', reason: 'source revoked'}, 'alice'), kind('dependent_versions'));
  await harbor.retire({reference: 'districts:1', reason: 'source revoked', cascade: true}, 'alice');
  assert.equal((await harbor.requestStatus('q2')).status, 'invalidated');
  await assert.rejects(harbor.fetchRelease('r', 'carol'), kind('release_revoked'));
  assert.equal((await harbor.budget('g')).spentRows, 2);
  assert.equal((await harbor.budget('g')).reservedRows, 0);
  assert.ok((await harbor.catalog()).datasets.every(dataset => dataset.current === null));
  assert.equal((await harbor.verify()).valid, true);
});

test('grant revocation withdraws existing artifacts and invalidates pending requests', async t => {
  const {harbor} = await setup(t);
  await approved(harbor);
  await harbor.release({id: 'r', request: 'q'}, 'alice');
  await harbor.request(request({id: 'q2'}), 'carol');
  const revoked = await harbor.revoke({id: 'g', reason: 'agreement withdrawn'}, 'alice');
  assert.deepEqual(revoked.requests, ['q2']);
  assert.deepEqual(revoked.releases, ['r']);
  await assert.rejects(harbor.request(request({id: 'q3'}), 'carol'), kind('grant_revoked'));
  await assert.rejects(harbor.fetchRelease('r', 'carol'), kind('release_revoked'));
  assert.equal((await harbor.revoke({id: 'g', reason: 'repeat'}, 'alice')).committed, false);
  assert.equal((await harbor.verify()).valid, true);
});

test('organization suspension propagates to both reserved and delivered products', async t => {
  const {harbor} = await setup(t);
  await approved(harbor);
  await harbor.release({id: 'r', request: 'q'}, 'alice');
  await harbor.request(request({id: 'q2'}), 'carol');
  await assert.rejects(harbor.suspend({id: 'partner', reason: 'suspend'}, 'alice'), kind('steward'));
  const suspended = await harbor.suspend({id: 'partner', reason: 'partner stopped participation'}, 'carol');
  assert.deepEqual(suspended.grants, ['g']);
  assert.equal((await harbor.requestStatus('q2')).status, 'invalidated');
  await assert.rejects(harbor.fetchRelease('r', 'carol'), kind('release_revoked'));
  assert.equal((await harbor.verify()).valid, true);
});

test('change sets compare row hashes, preserve base version and record lineage', async t => {
  const {harbor} = await setup(t);
  const original = (await harbor.rows({reference: 'people:1'}, 'alice')).rows;
  const input = {dataset: 'people', base: 'people:1', expectedCurrent: 'people:1', importId: 'changed', changes: [
    {operation: 'update', key: ['a'], row: {...original[0], hours: 12}, expectedHash: checksum(original[0])},
    {operation: 'delete', key: ['c'], expectedHash: checksum(original[2])},
    {operation: 'insert', key: ['d'], row: {id: 'd', district: 'delta', hours: 8, note: null}},
  ]};
  const preview = await harbor.previewChanges(input, 'alice');
  assert.deepEqual(preview.changes, {inserted: 1, updated: 1, deleted: 1});
  assert.equal(preview.resultingRows, 3);
  const changed = await harbor.changes(input, 'alice');
  assert.equal(changed.version.reference, 'people:2');
  assert.deepEqual(changed.version.dependencies, ['people:1']);
  assert.equal((await harbor.rows({reference: 'people:1'}, 'alice')).rows[0].hours, 10);
  assert.equal((await harbor.rows({reference: 'people:2'}, 'alice')).rows[0].hours, 12);
  const diff = await harbor.compare({before: 'people:1', after: 'people:2'}, 'alice');
  assert.deepEqual(diff.counts, {added: 1, removed: 1, changed: 1, equal: 1});
  assert.equal((await harbor.changes(input, 'alice')).replay, true);
  assert.equal((await harbor.verify()).valid, true);
});

test('change conflict and repeated key abort the entire new version', async t => {
  const {harbor} = await setup(t);
  const input = {dataset: 'people', base: 'people:1', expectedCurrent: 'people:1', importId: 'bad', changes: [
    {operation: 'delete', key: ['a'], expectedHash: '0'.repeat(64)},
  ]};
  await assert.rejects(harbor.changes(input, 'alice'), kind('change_conflict'));
  const original = (await harbor.rows({reference: 'people:1'}, 'alice')).rows[0];
  input.changes = [{operation: 'update', key: ['a'], expectedHash: checksum(original), row: original},
    {operation: 'delete', key: ['a'], expectedHash: checksum(original)}];
  await assert.rejects(harbor.changes(input, 'alice'), kind('change_duplicate'));
  assert.equal((await harbor.catalog()).versions.length, 1);
  assert.equal((await harbor.rows({reference: 'people:1'}, 'alice')).total, 3);
});

test('join derivation is many-to-one with pinned lineage and inherited classification', async t => {
  const {harbor} = await setup(t);
  await addDistricts(harbor);
  await harbor.dataset({id: 'enriched', name: 'Enriched synthetic table', owner: 'owner', schema: {
    columns: [{name: 'person', type: 'string', classification: 'sensitive'},
      {name: 'district_name', type: 'string', classification: 'public'},
      {name: 'hours', type: 'integer', classification: 'public'}], primaryKey: ['person']}}, 'alice');
  const recipe = {dataset: 'enriched', importId: 'joined', left: 'people:1',
    join: {reference: 'districts:1', leftColumns: ['district'], rightColumns: ['code']},
    projection: [{target: 'person', source: 'left.id'}, {target: 'district_name', source: 'right.name'},
      {target: 'hours', source: 'left.hours'}]};
  const preview = await harbor.previewDerive(recipe, 'alice');
  assert.equal(preview.report.joinedRows, 3);
  assert.equal(preview.report.unmatched, 0);
  const derived = await harbor.derive(recipe, 'alice');
  assert.equal(derived.version.rows, 3);
  assert.deepEqual(derived.version.dependencies, ['districts:1', 'people:1']);
  assert.equal((await harbor.rows({reference: 'enriched:1'}, 'alice')).rows[0].district_name, 'Synthetic delta');
  assert.equal((await harbor.derive(recipe, 'alice')).replay, true);
  const impact = await harbor.retirementImpact('people:1', 'alice');
  assert.ok(impact.versions.includes('enriched:1'));
});

test('aggregate derivation computes totals and blocks classification downgrade', async t => {
  const {harbor} = await setup(t);
  await harbor.dataset({id: 'totals', name: 'District totals', owner: 'owner', schema: {
    columns: [{name: 'district', type: 'string', classification: 'public'},
      {name: 'hours', type: 'integer', classification: 'public'},
      {name: 'participants', type: 'integer', classification: 'public'}], primaryKey: ['district']}}, 'alice');
  const recipe = {dataset: 'totals', importId: 'sum', left: 'people:1',
    projection: [{target: 'district', source: 'left.district'}, {target: 'hours', source: 'left.hours'}],
    groupBy: ['district'], aggregates: [{target: 'hours', operation: 'sum', source: 'hours'},
      {target: 'participants', operation: 'count'}]};
  const result = await harbor.derive(recipe, 'alice');
  assert.equal(result.version.status, 'validated');
  const table = await harbor.rows({reference: 'totals:1'}, 'alice');
  assert.deepEqual(table.rows[0], {district: 'delta', hours: 30, participants: 2});
  assert.deepEqual(table.rows[1], {district: 'hill', hours: 30, participants: 1});
  await harbor.dataset({id: 'unsafe', name: 'Unsafe projection', owner: 'owner', schema: {
    columns: [{name: 'person', type: 'string', classification: 'public'}], primaryKey: ['person']}}, 'alice');
  await assert.rejects(harbor.derive({dataset: 'unsafe', importId: 'bad', left: 'people:1',
    projection: [{target: 'person', source: 'left.id'}]}, 'alice'), kind('derive_classification'));
});
