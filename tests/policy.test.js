import test from 'node:test';
import assert from 'node:assert/strict';
import {setup, grant, request, approved, kind} from './support.js';

test('disclosure tokenizes sensitive identities and suppresses small groups', async t => {
  const {harbor} = await setup(t);
  await approved(harbor);
  const pending = await harbor.requestStatus('q');
  assert.equal(pending.outputRows, 2);
  assert.equal(pending.approvalCount, 2);
  assert.equal(pending.status, 'approved');
  const result = await harbor.release({id: 'r', request: 'q'}, 'alice');
  assert.equal(result.release.rows, 2);
  const fetched = await harbor.fetchRelease('r', 'carol');
  const records = fetched.content.trim().split(String.fromCharCode(10)).map(JSON.parse);
  assert.equal(records.length, 2);
  assert.ok(records.every(row => /^[a-f0-9]{64}$/.test(row.id)));
  assert.ok(records.every(row => row.district === 'delta'));
  assert.ok(records.every(row => !Object.hasOwn(row, 'note')));
  assert.equal((await harbor.proof('r', 'carol')).manifestVerified, true);
  assert.equal((await harbor.verify()).valid, true);
});

test('clearance blocks unprotected sensitive and restricted columns', async t => {
  const {harbor} = await setup(t);
  await assert.rejects(harbor.grant(grant({transforms: {}}), 'alice'), kind('classification'));
  await assert.rejects(harbor.grant(grant({columns: ['id', 'district', 'note'],
    transforms: {id: {kind: 'tokenize'}, note: {kind: 'tokenize'}}}), 'alice'), kind('restricted'));
  const safe = await harbor.grant(grant({columns: ['id', 'district', 'note'],
    transforms: {id: {kind: 'tokenize'}, note: {kind: 'redact'}}}), 'alice');
  assert.equal(safe.grant.columns.includes('note'), true);
  await harbor.request(request({columns: ['id', 'district', 'note']}), 'carol');
  const status = await harbor.requestStatus('q');
  assert.equal(status.outputRows, 2);
  assert.equal(status.status, 'pending');
});

test('recipient, purpose, region and expiry are checked before reservations', async t => {
  const {harbor} = await setup(t);
  await assert.rejects(harbor.grant(grant({regions: ['north']}), 'alice'), kind('region'));
  await assert.rejects(harbor.grant(grant({purposes: ['marketing']}), 'alice'), kind('purpose'));
  await assert.rejects(harbor.grant(grant({expiresAt: '2026-10-01T00:00:00Z'}), 'alice'), kind('grant_expired'));
  await harbor.grant(grant(), 'alice');
  await assert.rejects(harbor.request(request({purpose: 'marketing'}), 'carol'), kind('purpose'));
  await assert.rejects(harbor.request(request({expiresAt: '2027-01-01T00:00:00Z'}), 'carol'), kind('request_expiry'));
  await assert.rejects(harbor.request(request({recipient: 'owner'}), 'alice'), kind('recipient'));
  assert.equal((await harbor.budget('g')).reservedRows, 0);
});

test('filtering cannot expose a hidden or transformed field through row selection', async t => {
  const {harbor} = await setup(t);
  await harbor.grant(grant(), 'alice');
  await assert.rejects(harbor.request(request({filters: [{column: 'id', operator: 'eq', value: 'a'}]}), 'carol'), kind('filter_disclosure'));
  await assert.rejects(harbor.request(request({filters: [{column: 'note', operator: 'is_null'}]}), 'carol'), kind('filter_disclosure'));
  await assert.rejects(harbor.request(request({columns: ['id', 'hours']}), 'carol'), kind('quasi_missing'));
  const allowed = await harbor.request(request({filters: [{column: 'district', operator: 'eq', value: 'delta'}]}), 'carol');
  assert.equal(allowed.request.outputRows, 2);
  assert.equal(allowed.request.disclosure.selectedRows, 2);
  assert.equal((await harbor.budget('g')).reservedRows, 2);
});

test('quorum binds distinct owner stewards and prevents premature release', async t => {
  const {harbor} = await setup(t);
  await harbor.grant(grant(), 'alice');
  await harbor.request(request(), 'carol');
  await assert.rejects(harbor.decide({id: 'q', decision: 'approve', reason: 'self approval'}, 'carol'), kind('steward'));
  await harbor.decide({id: 'q', decision: 'approve', reason: 'checked purpose'}, 'alice');
  assert.equal((await harbor.requestStatus('q')).status, 'pending');
  await assert.rejects(harbor.release({id: 'r', request: 'q'}, 'alice'), kind('request_state'));
  await assert.rejects(harbor.decide({id: 'q', decision: 'approve', reason: 'duplicate'}, 'alice'), kind('approval_duplicate'));
  await harbor.decide({id: 'q', decision: 'approve', reason: 'checked disclosure'}, 'bob');
  assert.equal((await harbor.requestStatus('q')).status, 'approved');
  assert.equal((await harbor.release({id: 'r', request: 'q'}, 'alice')).release.status, 'available');
});

test('same organization request still requires separation of duties', async t => {
  const {harbor} = await setup(t);
  await harbor.grant(grant({recipient: 'owner', approvalCount: 1}), 'alice');
  await harbor.request(request({recipient: 'owner'}), 'alice');
  await assert.rejects(harbor.decide({id: 'q', decision: 'approve', reason: 'self'}, 'alice'), kind('separation'));
  await harbor.decide({id: 'q', decision: 'approve', reason: 'independent review'}, 'bob');
  assert.equal((await harbor.requestStatus('q')).status, 'approved');
  await harbor.release({id: 'r', request: 'q'}, 'bob');
  assert.equal((await harbor.fetchRelease('r', 'alice')).release.rows, 2);
});

test('reservation prevents concurrent requests from overspending the row budget', async t => {
  const {harbor} = await setup(t);
  await harbor.grant(grant({rowBudget: 3}), 'alice');
  const results = await Promise.allSettled([harbor.request(request({id: 'q1'}), 'carol'),
    harbor.request(request({id: 'q2'}), 'carol')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const failure = results.find(result => result.status === 'rejected');
  assert.equal(failure.reason.kind, 'budget');
  const budget = await harbor.budget('g');
  assert.equal(budget.reservedRows, 2);
  assert.equal(budget.availableRows, 1);
  assert.equal(budget.spentRows, 0);
  assert.equal((await harbor.verify()).valid, true);
});

test('reject and cancel free reservations but published withdrawal does not refund spending', async t => {
  const {harbor} = await setup(t);
  await harbor.grant(grant({rowBudget: 4}), 'alice');
  await harbor.request(request(), 'carol');
  await harbor.decide({id: 'q', decision: 'reject', reason: 'purpose insufficient'}, 'alice');
  assert.equal((await harbor.budget('g')).reservedRows, 0);
  await harbor.request(request({id: 'q2'}), 'carol');
  await harbor.cancel({id: 'q2', reason: 'not needed'}, 'carol');
  assert.equal((await harbor.budget('g')).availableRows, 4);
  await harbor.request(request({id: 'q3'}), 'carol');
  await harbor.decide({id: 'q3', decision: 'approve', reason: 'checked'}, 'alice');
  await harbor.decide({id: 'q3', decision: 'approve', reason: 'checked'}, 'bob');
  await harbor.release({id: 'r', request: 'q3'}, 'alice');
  await harbor.withdraw({id: 'r', reason: 'data corrected'}, 'alice');
  const budget = await harbor.budget('g');
  assert.equal(budget.spentRows, 2);
  assert.equal(budget.availableRows, 2);
  assert.equal(budget.spentReleases, 1);
  await assert.rejects(harbor.fetchRelease('r', 'carol'), kind('release_revoked'));
});

test('request and release replay never spend budget twice', async t => {
  const {harbor} = await setup(t);
  await approved(harbor);
  const repeated = await harbor.request(request(), 'carol');
  assert.equal(repeated.replay, true);
  assert.equal(repeated.request.status, 'approved');
  const first = await harbor.release({id: 'r', request: 'q'}, 'alice');
  const second = await harbor.release({id: 'r', request: 'q'}, 'alice');
  assert.equal(second.replay, true);
  assert.equal(second.generation, first.generation);
  assert.equal((await harbor.budget('g')).spentRows, 2);
  assert.equal((await harbor.budget('g')).spentReleases, 1);
  await assert.rejects(harbor.release({id: 'r2', request: 'q'}, 'alice'), kind('request_state'));
});

test('expiry blocks approval and retrieval and sweep frees only reservations', async t => {
  const {harbor, setTime} = await setup(t);
  await approved(harbor);
  await harbor.release({id: 'r', request: 'q'}, 'alice');
  await harbor.request(request({id: 'q2'}), 'carol');
  setTime('2026-11-20T00:00:00Z');
  await assert.rejects(harbor.decide({id: 'q2', decision: 'approve', reason: 'late'}, 'alice'), kind('request_expired'));
  await assert.rejects(harbor.fetchRelease('r', 'carol'), kind('release_expired'));
  assert.deepEqual((await harbor.expire('operator')).expired, ['q2']);
  assert.equal((await harbor.budget('g')).reservedRows, 0);
  assert.equal((await harbor.budget('g')).spentRows, 2);
  assert.equal((await harbor.expire('operator')).committed, false);
});
