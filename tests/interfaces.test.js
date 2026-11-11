import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {setup, rows, grant, request, approved, kind} from './support.js';
import {serve, apiServer} from '../src/api.js';
import {runCommand, parseArguments} from '../src/main.js';
import {checksum} from '../src/primitives.js';

test('immutable table pagination survives unrelated catalog writes', async t => {
  const {harbor} = await setup(t);
  const first = await harbor.rows({reference: 'people:1', limit: 1}, 'alice');
  assert.equal(first.rows[0].id, 'a');
  assert.equal(first.total, 3);
  assert.ok(first.next);
  await harbor.grant(grant(), 'alice');
  const second = await harbor.rows({reference: 'people:1', limit: 1, cursor: first.next}, 'alice');
  assert.equal(second.rows[0].id, 'b');
  const third = await harbor.rows({reference: 'people:1', limit: 1, cursor: second.next}, 'alice');
  assert.equal(third.rows[0].id, 'c');
  assert.equal(third.next, null);
  await assert.rejects(harbor.rows({reference: 'people:1', limit: 2, cursor: first.next}, 'alice'), kind('cursor_query'));
  await assert.rejects(harbor.rows({reference: 'people:1', cursor: 'broken'}, 'alice'), kind('cursor'));
});

test('row query projection and typed filtering remain steward-only', async t => {
  const {harbor} = await setup(t);
  const query = {reference: 'people:1', columns: ['id', 'hours'], filters: [{column: 'hours', operator: 'gte', value: 20}]};
  const result = await harbor.rows(query, 'alice');
  assert.equal(result.total, 2);
  assert.deepEqual(result.rows[0], {id: 'b', hours: 20});
  assert.equal(Object.hasOwn(result.rows[0], 'note'), false);
  await assert.rejects(harbor.rows(query, 'carol'), kind('steward'));
  await assert.rejects(harbor.rows({...query, columns: ['id', 'id']}, 'alice'), kind('query_columns'));
  await assert.rejects(harbor.rows({...query, columns: ['unknown']}, 'alice'), kind('query_columns'));
});

test('owner, recipient and worklist reports expose workflow without raw private rows', async t => {
  const {harbor} = await setup(t);
  await harbor.grant(grant(), 'alice');
  await harbor.request(request(), 'carol');
  const owner = await harbor.ownerReport('owner', 'alice');
  assert.equal(owner.waitingRequests.length, 1);
  assert.equal(owner.classifications.sensitive, 1);
  assert.equal(owner.classifications.restricted, 1);
  assert.equal(owner.storedRows, 3);
  const worklist = await harbor.worklist('bob');
  assert.equal(worklist[0].id, 'q');
  assert.equal(worklist[0].suppressed, 1);
  await harbor.decide({id: 'q', decision: 'approve', reason: 'checked'}, 'bob');
  assert.equal((await harbor.worklist('bob')).length, 0);
  const recipient = await harbor.recipientReport('partner', 'carol');
  assert.equal(recipient.requests[0].outputRows, 2);
  assert.equal(recipient.grants[0].dataset, 'people');
  assert.equal(JSON.stringify(recipient).includes('local-only'), false);
  await assert.rejects(harbor.ownerReport('owner', 'carol'), kind('steward'));
});

test('audit export declares its filtered scope and has a verifiable checksum', async t => {
  const {harbor} = await setup(t);
  await approved(harbor);
  const audit = await harbor.auditExport({owner: 'owner'}, 'alice');
  assert.equal(audit.completeGlobalChain, false);
  assert.ok(audit.entries.length > 0);
  assert.ok(audit.entries.every(entry => ['alice', 'bob'].includes(entry.actor)));
  const {checksum: hash, completeGlobalChain, ...body} = audit;
  assert.equal(checksum(body), hash);
  const filtered = await harbor.audit({actor: 'bob', operation: 'request.decide'});
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].details.decision, 'approve');
  assert.ok((await harbor.storageReport()).uniqueObjects > 0);
});

test('API requires a configured token and explicit actor identity', async t => {
  const {harbor} = await setup(t);
  assert.throws(() => apiServer(harbor, {token: 'short'}), kind('api_token'));
  const server = await serve(harbor, {port: 0, token: 'synthetic-api-token'});
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + '/status')).status, 401);
  const noActor = await fetch(base + '/status', {headers: {authorization: 'Bearer synthetic-api-token'}});
  assert.equal(noActor.status, 400);
  const headers = {authorization: 'Bearer synthetic-api-token', 'x-actor': 'alice'};
  const response = await fetch(base + '/status', {headers});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).versions.active, 1);
  assert.equal((await fetch(base + '/unknown', {headers})).status, 404);
  assert.equal((await fetch(base + '/status', {method: 'DELETE', headers})).status, 405);
});

test('API import enforces optimistic generation and content parsing', async t => {
  const {harbor} = await setup(t);
  const server = await serve(harbor, {port: 0, token: 'synthetic-api-token'});
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = {authorization: 'Bearer synthetic-api-token', 'x-actor': 'alice', 'content-type': 'application/json'};
  const input = {dataset: 'people', importId: 'http', rows: rows()};
  const stale = await fetch(base + '/imports', {method: 'POST', headers: {...headers, 'if-match': '0'}, body: JSON.stringify(input)});
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error, 'stale');
  const malformed = await fetch(base + '/imports', {method: 'POST', headers, body: '{'});
  assert.equal((await malformed.json()).error, 'json');
  const valid = await fetch(base + '/imports', {method: 'POST', headers, body: JSON.stringify(input)});
  assert.equal(valid.status, 200);
  assert.equal((await valid.json()).version.reference, 'people:2');
  const denied = await fetch(base + '/versions/rows', {method: 'POST', headers: {...headers, 'x-actor': 'carol'},
    body: JSON.stringify({reference: 'people:2'})});
  assert.equal(denied.status, 403);
});

test('API released product remains retrievable only by recipient or owner actors', async t => {
  const {harbor} = await setup(t);
  await approved(harbor);
  await harbor.release({id: 'r', request: 'q'}, 'alice');
  const server = await serve(harbor, {port: 0, token: 'synthetic-api-token'});
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/release?id=r`;
  const headers = {authorization: 'Bearer synthetic-api-token', 'x-actor': 'carol'};
  const fetched = await fetch(url, {headers});
  assert.equal(fetched.status, 200);
  const document = await fetched.json();
  assert.equal(document.manifest.rows, 2);
  assert.equal(document.content.includes('local-only'), false);
  const outsider = await fetch(url, {headers: {...headers, 'x-actor': 'outsider'}});
  assert.equal(outsider.status, 403);
  await harbor.revoke({id: 'g', reason: 'agreement ended'}, 'alice');
  assert.equal((await fetch(url, {headers})).status, 410);
});

test('CLI executes real data operations and reports invalid options', async t => {
  const {harbor, root} = await setup(t);
  assert.equal((await runCommand(['status', '--root', root])).versions.active, 1);
  const input = path.join(root, 'query.json');
  await writeFile(input, JSON.stringify({reference: 'people:1', limit: 1}));
  const result = await runCommand(['rows', '--root', root, '--actor', 'alice', '--input', input]);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].id, 'a');
  assert.ok((await runCommand(['help'])).commands.includes('release'));
  assert.throws(() => parseArguments(['status', '--root']), kind('arguments'));
  assert.throws(() => parseArguments(['status', '--root', 'a', '--root', 'b']), kind('arguments'));
  assert.throws(() => parseArguments(['status', '--unknown', 'x']), kind('arguments'));
  await assert.rejects(runCommand(['status']), kind('arguments'));
  await assert.rejects(runCommand(['unknown', '--root', root]), kind('command'));
});

test('risk inspection and version comparison do not mutate vault generation', async t => {
  const {harbor} = await setup(t);
  await harbor.import({dataset: 'people', importId: 'two', rows: [rows()[0], {...rows()[1], hours: 25}]}, 'alice');
  const before = await harbor.status();
  const risk = await harbor.risk({reference: 'people:1', quasiIdentifiers: ['district']}, 'alice');
  assert.equal(risk.uniqueRows, 1);
  const comparison = await harbor.compare({before: 'people:1', after: 'people:2', maximumDetails: 1}, 'alice');
  assert.equal(comparison.counts.changed, 1);
  assert.equal(comparison.counts.removed, 1);
  assert.equal(comparison.details.length, 1);
  assert.equal(comparison.truncated, true);
  assert.equal((await harbor.status()).generation, before.generation);
});
