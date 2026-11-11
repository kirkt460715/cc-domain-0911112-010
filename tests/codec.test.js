import test from 'node:test';
import assert from 'node:assert/strict';
import {schemaSpec, castCell, compareSchemas} from '../src/schema.js';
import {csvTable, writeTable, parseTable, normalizeMapping, transformRows} from '../src/tabular.js';
import {protectValue, disclosureRisk, filterSpec, matches} from '../src/disclosure.js';
import {validateTable, tableProfile, gateSpec, evaluateGate, profileDrift} from '../src/quality.js';
import {instant, key, encode, checksum, splitVersion} from '../src/primitives.js';
import {schema, rows, kind} from './support.js';
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const Q = String.fromCharCode(34);

test('CSV finite-state parser preserves embedded delimiters and quoted newlines', () => {
  const content = ['id,note', `a,${Q}one,two${Q}`, `b,${Q}line1`, `line2${Q}`, `c,${Q}a${Q}${Q}b${Q}`].join(LF);
  const parsed = csvTable(content);
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0].note, 'one,two');
  assert.equal(parsed[1].note, 'line1' + LF + 'line2');
  assert.equal(parsed[2].note, 'a' + Q + 'b');
  assert.deepEqual(csvTable(writeTable(parsed, ['id', 'note'], 'csv')), parsed);
  const bom = String.fromCharCode(0xfeff) + 'id;note' + CR + LF + 'a;ok' + CR + LF;
  assert.deepEqual(csvTable(bom, ';'), [{id: 'a', note: 'ok'}]);
});

test('CSV rejects malformed widths, duplicate headers and incomplete quoting', () => {
  assert.throws(() => csvTable('id,id' + LF + 'a,b'), kind('csv_header'));
  assert.throws(() => csvTable('id,note' + LF + 'a'), kind('csv_width'));
  assert.throws(() => csvTable('id,note' + LF + 'a,' + Q + 'open'), kind('csv_quote'));
  assert.throws(() => csvTable('id,note' + LF + 'a,' + Q + 'closed' + Q + 'junk'), kind('csv_quote'));
  assert.throws(() => csvTable('constructor' + LF + 'x'), kind('identifier'));
  assert.throws(() => csvTable(''), kind('csv_empty'));
  assert.throws(() => csvTable('id|note', '|'), kind('separator'));
  assert.deepEqual(csvTable('id,note'), []);
});

test('export formats preserve types and prevent spreadsheet formula interpretation', () => {
  const data = [{id: '=formula', value: -2}, {id: '@formula', value: 0}];
  const csv = csvTable(writeTable(data, ['id', 'value'], 'csv'));
  assert.equal(csv[0].id, String.fromCharCode(39) + '=formula');
  assert.equal(csv[0].value, '-2');
  assert.equal(csv[1].id, String.fromCharCode(39) + '@formula');
  assert.deepEqual(parseTable(writeTable(data, ['id', 'value'], 'json'), 'json'), data);
  assert.deepEqual(parseTable(writeTable(data, ['id', 'value'], 'jsonl'), 'jsonl'), data);
  assert.throws(() => parseTable('{}' + LF + '{', 'jsonl'), kind('json'));
  assert.throws(() => parseTable('{}', 'json'), kind('list'));
});

test('typed cell casting validates dates, safe integers, booleans and enums', () => {
  const definition = schemaSpec({columns: [
    {name: 'id', type: 'integer', classification: 'public'},
    {name: 'flag', type: 'boolean', classification: 'public'},
    {name: 'day', type: 'date', classification: 'public'},
    {name: 'state', type: 'enum', classification: 'public', values: ['yes', 'no'], case: 'lower'},
  ], primaryKey: ['id']});
  const [id, flag, day, state] = definition.columns;
  assert.equal(castCell('10', id, {coerce: true}), 10);
  assert.equal(castCell('false', flag, {coerce: true}), false);
  assert.equal(castCell('2024-02-29', day), '2024-02-29');
  assert.equal(castCell(' YES ', state), 'yes');
  assert.throws(() => castCell('0x10', id, {coerce: true}), kind('cell_number'));
  assert.throws(() => castCell(Number.MAX_SAFE_INTEGER + 1, id), kind('cell_integer'));
  assert.throws(() => castCell('1', flag, {coerce: true}), kind('cell_boolean'));
  assert.throws(() => castCell('2026-02-29', day), kind('time'));
  assert.throws(() => castCell('maybe', state), kind('cell_enum'));
});

test('schema enforces non-null complete primary keys and unique column names', () => {
  const duplicate = schema();
  duplicate.columns.push({...duplicate.columns[0]});
  assert.throws(() => schemaSpec(duplicate), kind('duplicate'));
  const nullable = schema();
  nullable.columns[0].nullable = true;
  assert.throws(() => schemaSpec(nullable), kind('primary_key'));
  assert.throws(() => schemaSpec({...schema(), primaryKey: ['missing']}), kind('primary_key'));
  assert.throws(() => schemaSpec({...schema(), primaryKey: []}), kind('primary_key'));
  const old = schemaSpec(schema());
  const modified = schemaSpec({...schema(), primaryKey: ['district']});
  assert.equal(compareSchemas(old, modified).compatible, false);
  assert.ok(compareSchemas(old, modified).issues.some(issue => issue.code === 'primary_key_changed'));
});

test('composite foreign keys distinguish all-null from partially-null values', () => {
  const definition = schemaSpec({columns: [
    {name: 'id', type: 'string', classification: 'public'},
    {name: 'region', type: 'string', classification: 'public', nullable: true},
    {name: 'code', type: 'integer', classification: 'public', nullable: true},
  ], primaryKey: ['id'], foreignKeys: [{columns: ['region', 'code'], target: 'lookup', targetColumns: ['region', 'code']}]});
  const input = [{id: 'a', region: null, code: null}, {id: 'b', region: 'south', code: 1},
    {id: 'c', region: null, code: 1}, {id: 'd', region: 'north', code: 2}];
  const result = validateTable(input, definition, {lookup: {rows: [{region: 'south', code: 1}]}});
  assert.equal(result.rows.length, 2);
  assert.equal(result.report.issues.partial_foreign_key, 1);
  assert.equal(result.report.issues.foreign_key, 1);
  assert.equal(result.rejected[0].index, 2);
  assert.equal(result.rows[0].region, null);
  assert.throws(() => validateTable(input, definition), kind('reference_missing'));
});

test('column profiles and drift preserve null counts and numeric distribution', () => {
  const definition = schemaSpec(schema());
  const before = tableProfile(rows(), definition);
  assert.equal(before.columns.note.nulls, 1);
  assert.equal(before.columns.hours.mean, 20);
  assert.equal(before.columns.hours.minimum, 10);
  assert.equal(before.columns.hours.maximum, 30);
  const after = tableProfile(rows().map(row => ({...row, hours: row.hours + 5, note: null})), definition);
  const drift = profileDrift(before, after);
  assert.equal(drift.rowChange, 0);
  assert.equal(drift.columns.find(item => item.column === 'hours').meanChange, 5);
  assert.ok(drift.columns.find(item => item.column === 'note').nullRateChange > 0.6);
  const gate = gateSpec({minimumRows: 4, maxNullFractions: {note: 0.5}});
  const evaluated = evaluateGate({accepted: 3, rejectionRate: 0}, after, gate);
  assert.equal(evaluated.passed, false);
  assert.equal(evaluated.failures.length, 2);
});

test('disclosure transforms are deterministic, scoped and type-preserving where appropriate', () => {
  const secret = Buffer.alloc(32, 7);
  const first = protectValue('person-a', {kind: 'tokenize'}, secret, 'partner-a');
  assert.equal(first, protectValue('person-a', {kind: 'tokenize'}, secret, 'partner-a'));
  assert.notEqual(first, protectValue('person-a', {kind: 'tokenize'}, secret, 'partner-b'));
  assert.equal(protectValue('secret', {kind: 'redact'}, secret, 'x'), null);
  assert.equal(protectValue(-1, {kind: 'bucket', width: 10}, secret, 'x'), -10);
  assert.equal(protectValue(29, {kind: 'bucket', width: 10}, secret, 'x'), 20);
  assert.equal(protectValue('中文地区', {kind: 'prefix', length: 2}, secret, 'x'), '中文');
  assert.equal(protectValue('2026-11-11', {kind: 'date_floor', unit: 'month'}, secret, 'x'), '2026-11-01');
  assert.equal(protectValue(null, {kind: 'tokenize'}, secret, 'x'), null);
});

test('risk profile counts equivalence groups without claiming anonymity guarantees', () => {
  const profile = disclosureRisk(rows(), ['id', 'district', 'hours', 'note'], ['district']);
  assert.equal(profile.rows, 3);
  assert.equal(profile.groups, 2);
  assert.equal(profile.smallestGroup, 1);
  assert.equal(profile.uniqueRows, 1);
  assert.deepEqual(profile.groupSizes, [1, 2]);
  assert.equal(profile.maximumReidentificationFraction, 1);
  assert.throws(() => disclosureRisk(rows(), ['id'], ['district']), kind('quasi'));
});

test('filters handle nulls without numeric coercion', () => {
  const definition = schemaSpec(schema());
  const filter = filterSpec([{column: 'hours', operator: 'gte', value: 20}], definition);
  assert.equal(matches(rows()[0], filter), false);
  assert.equal(matches(rows()[1], filter), true);
  assert.equal(matches({hours: null}, filter), false);
  const nullFilter = filterSpec([{column: 'note', operator: 'is_null'}], definition);
  assert.equal(matches(rows()[0], nullFilter), false);
  assert.equal(matches(rows()[1], nullFilter), true);
  assert.throws(() => filterSpec([{column: 'unknown', operator: 'eq', value: 1}], definition), kind('filter_column'));
  assert.throws(() => filterSpec([{column: 'hours', operator: 'in', value: 1}], definition), kind('list'));
});

test('transform plans reject duplicate targets and preserve explicit null defaults', () => {
  const plan = normalizeMapping([{target: 'id', source: 'person', operations: [{kind: 'lower'}]},
    {target: 'district', default: 'delta'}, {target: 'hours', source: 'hours', operations: [{kind: 'offset', value: 2}]},
    {target: 'note', default: null}], ['id', 'district', 'hours', 'note']);
  const transformed = transformRows([{person: 'A', hours: 10}], plan, ['id', 'district', 'hours', 'note']);
  assert.deepEqual(transformed[0], {id: 'a', district: 'delta', hours: 12, note: null});
  assert.throws(() => normalizeMapping([{target: 'id', default: 1}, {target: 'id', default: 2}], ['id']), kind('mapping_duplicate'));
  assert.throws(() => normalizeMapping([{target: 'unknown', default: 1}], ['id']), kind('mapping_target'));
  assert.throws(() => normalizeMapping([{target: 'id'}], ['id']), kind('mapping_source'));
});

test('canonical value and version reference validation prevent ambiguous identities', () => {
  assert.equal(encode({z: 2, a: 1}), encode({a: 1, z: 2}));
  assert.equal(checksum({a: 1}), checksum({a: 1}));
  assert.throws(() => encode({a: Infinity}), kind('number'));
  assert.throws(() => key('constructor'), kind('identifier'));
  assert.throws(() => key('UpperCase'), kind('identifier'));
  assert.equal(instant('2026-11-01T00:00:00Z'), '2026-11-01T00:00:00.000Z');
  assert.throws(() => instant('2026-02-30T00:00:00Z'), kind('time'));
  assert.deepEqual(splitVersion('people:12'), {dataset: 'people', version: 12});
  assert.throws(() => splitVersion('people:01'), kind('version'));
  assert.throws(() => splitVersion('people:0'), kind('version'));
});
