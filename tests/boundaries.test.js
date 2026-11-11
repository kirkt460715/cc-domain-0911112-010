import test from 'node:test';
import assert from 'node:assert/strict';
import {setup, rows, schema, grant, request, approved, kind} from './support.js';
import {schemaSpec, compareSchemas} from '../src/schema.js';
import {filterSpec, buildDisclosure} from '../src/disclosure.js';
import {normalizeMapping, transformRows} from '../src/tabular.js';

test('numeric filters reject implicit string coercion and unsafe comparisons', () => {
  const definition = schemaSpec(schema());
  assert.throws(() => filterSpec([{column: 'hours', operator: 'gte', value: '20'}], definition), kind('number'));
  assert.throws(() => filterSpec([{column: 'hours', operator: 'in', value: [10, '20']}], definition), kind('number'));
  const valid = filterSpec([{column: 'hours', operator: 'in', value: [10, 20]}], definition);
  assert.deepEqual(valid[0].value, [10, 20]);
  assert.throws(() => filterSpec([{column: 'id', operator: 'eq', value: null}], definition), kind('null'));
  const nullable = filterSpec([{column: 'note', operator: 'eq', value: null}], definition);
  assert.equal(nullable[0].value, null);
});

test('schema compatibility catches narrowing and identity normalization changes', () => {
  const before = schemaSpec(schema());
  const narrowed = schema();
  narrowed.columns[2].maximum = 20;
  const result = compareSchemas(before, schemaSpec(narrowed));
  assert.equal(result.compatible, false);
  assert.ok(result.issues.some(issue => issue.code === 'bounds_narrowed'));
  const shorter = schema();
  shorter.columns[0].maxLength = 2;
  assert.ok(compareSchemas(before, schemaSpec(shorter)).issues.some(issue => issue.code === 'length_narrowed'));
  const lower = schema();
  lower.columns[0].case = 'lower';
  assert.ok(compareSchemas(before, schemaSpec(lower)).issues.some(issue => issue.code === 'normalization_changed'));
  assert.equal(compareSchemas(before, before).compatible, true);
});

test('numeric transformation rejects empty input rather than inventing zero', () => {
  const mapping = normalizeMapping([{target: 'hours', source: 'raw', operations: [{kind: 'scale', value: 2}]}], ['hours']);
  assert.throws(() => transformRows([{raw: ''}], mapping, ['hours']), kind('transform_type'));
  assert.throws(() => transformRows([{raw: '   '}], mapping, ['hours']), kind('transform_type'));
  assert.throws(() => transformRows([{raw: false}], mapping, ['hours']), kind('transform_type'));
  assert.equal(transformRows([{raw: '0'}], mapping, ['hours'])[0].hours, 0);
  assert.equal(transformRows([{raw: 3}], mapping, ['hours'])[0].hours, 6);
  assert.equal(transformRows([{raw: null}], mapping, ['hours'])[0].hours, null);
});

test('release-count budget independently limits delivery even when rows remain', async t => {
  const {harbor} = await setup(t);
  await approved(harbor, {rowBudget: 1000, releaseLimit: 1});
  const before = await harbor.budget('g');
  assert.equal(before.availableRows, 998);
  assert.equal(before.availableReleases, 0);
  await assert.rejects(harbor.request(request({id: 'second'}), 'carol'), kind('budget'));
  await harbor.release({id: 'r', request: 'q'}, 'alice');
  const after = await harbor.budget('g');
  assert.equal(after.spentReleases, 1);
  assert.equal(after.reservedReleases, 0);
  assert.equal(after.availableRows, 998);
  await assert.rejects(harbor.request(request({id: 'third'}), 'carol'), kind('budget'));
});

test('suppression groups are evaluated after generalization, not on raw values', async t => {
  const {harbor} = await setup(t);
  await harbor.grant(grant({columns: ['id', 'district', 'hours'], minimumGroup: 3,
    quasiIdentifiers: ['hours'], transforms: {id: {kind: 'tokenize'}, hours: {kind: 'bucket', width: 100}}}), 'alice');
  const proposed = await harbor.request(request(), 'carol');
  assert.equal(proposed.request.outputRows, 3);
  assert.equal(proposed.request.disclosure.suppressedRows, 0);
  assert.equal(proposed.request.disclosure.groups, 1);
  await harbor.decide({id: 'q', decision: 'approve', reason: 'reviewed'}, 'alice');
  await harbor.decide({id: 'q', decision: 'approve', reason: 'reviewed'}, 'bob');
  await harbor.release({id: 'r', request: 'q'}, 'alice');
  const released = (await harbor.fetchRelease('r', 'carol')).content.trim().split(String.fromCharCode(10)).map(JSON.parse);
  assert.ok(released.every(row => row.hours === 0));
  assert.equal(released.length, 3);
});

test('request whose every group is suppressed reserves no budget', async t => {
  const {harbor} = await setup(t);
  await harbor.grant(grant({minimumGroup: 4}), 'alice');
  await assert.rejects(harbor.request(request(), 'carol'), kind('empty_release'));
  assert.equal((await harbor.budget('g')).reservedRows, 0);
  assert.equal((await harbor.budget('g')).availableRows, 20);
  assert.equal((await harbor.status()).requests.pending, undefined);
  assert.equal((await harbor.verify()).valid, true);
});

test('tokenization is stable across releases for a recipient and separated across recipients', async t => {
  const {harbor} = await setup(t);
  await approved(harbor);
  await harbor.release({id: 'r', request: 'q'}, 'alice');
  const first = await harbor.fetchRelease('r', 'carol');
  await harbor.request(request({id: 'q2'}), 'carol');
  const index = await harbor.vault.snapshot();
  assert.equal(index.requests.q2.outputHash, first.manifest.outputHash);
  await harbor.organization({id: 'other', name: 'Other synthetic partner', region: 'south',
    purposes: ['research'], stewards: ['dave']}, 'bootstrap');
  await harbor.grant(grant({id: 'other-grant', recipient: 'other'}), 'alice');
  await harbor.request(request({id: 'q3', grant: 'other-grant', recipient: 'other'}), 'dave');
  const changed = await harbor.vault.snapshot();
  assert.notEqual(changed.requests.q3.outputHash, first.manifest.outputHash);
  assert.equal(changed.requests.q3.outputRows, 2);
});

test('a changed current version does not silently retarget an approved release', async t => {
  const {harbor} = await setup(t);
  await approved(harbor);
  const updated = rows().map(row => ({...row, hours: row.hours + 100}));
  await harbor.import({dataset: 'people', importId: 'new-current', rows: updated}, 'alice');
  await harbor.activate({dataset: 'people', version: 2, expectedCurrent: 'people:1'}, 'alice');
  const released = await harbor.release({id: 'r', request: 'q'}, 'alice');
  assert.equal(released.manifest.reference, 'people:1');
  const delivered = (await harbor.fetchRelease('r', 'carol')).content.trim().split(String.fromCharCode(10)).map(JSON.parse);
  assert.ok(delivered.every(row => row.hours < 100));
  assert.equal((await harbor.catalog()).datasets[0].current, 'people:2');
  assert.equal((await harbor.verify()).valid, true);
});
