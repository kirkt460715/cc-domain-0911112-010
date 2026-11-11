import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {Harbor} from './service.js';
const root = await mkdtemp(path.join(os.tmpdir(), 'harbor-example-'));
try {
  const harbor = new Harbor(root, {clock: () => new Date('2026-11-01T00:00:00Z')});
  await harbor.organization({id: 'local', name: 'Synthetic local institute', region: 'south',
    purposes: ['research'], stewards: ['alice', 'bob']}, 'bootstrap');
  await harbor.organization({id: 'partner', name: 'Synthetic training partner', region: 'south',
    purposes: ['research'], stewards: ['carol']}, 'bootstrap');
  await harbor.dataset({id: 'training', name: 'Synthetic course participation', owner: 'local', schema: {
    columns: [
      {name: 'person', type: 'string', classification: 'sensitive'},
      {name: 'district', type: 'string', classification: 'public'},
      {name: 'hours', type: 'integer', classification: 'public', minimum: 0},
    ], primaryKey: ['person'],
  }}, 'alice');
  const imported = await harbor.import({dataset: 'training', importId: 'first', rows: [
    {person: 'synthetic-a', district: 'delta', hours: 12},
    {person: 'synthetic-b', district: 'delta', hours: 20},
    {person: 'synthetic-c', district: 'hill', hours: 8},
  ]}, 'alice');
  assert.equal(imported.version.status, 'validated');
  await harbor.activate({dataset: 'training', version: 1}, 'alice');
  await harbor.grant({id: 'research', dataset: 'training', recipient: 'partner', purposes: ['research'],
    columns: ['person', 'district', 'hours'], transforms: {person: {kind: 'tokenize'}},
    rowBudget: 10, expiresAt: '2026-12-01T00:00:00Z', minimumGroup: 2, quasiIdentifiers: ['district'], approvalCount: 2}, 'alice');
  const request = await harbor.request({id: 'delivery', grant: 'research', reference: 'training:1', recipient: 'partner',
    purpose: 'research', columns: ['person', 'district', 'hours'], expiresAt: '2026-11-20T00:00:00Z'}, 'carol');
  assert.equal(request.request.outputRows, 2);
  assert.equal(request.request.disclosure.suppressedRows, 1);
  await harbor.decide({id: 'delivery', decision: 'approve', reason: 'purpose reviewed'}, 'alice');
  await harbor.decide({id: 'delivery', decision: 'approve', reason: 'disclosure reviewed'}, 'bob');
  const released = await harbor.release({id: 'package', request: 'delivery'}, 'alice');
  assert.equal(released.release.rows, 2);
  const fetched = await harbor.fetchRelease('package', 'carol');
  assert.equal(fetched.content.includes('synthetic-a'), false);
  assert.equal((await harbor.budget('research')).spentRows, 2);
  assert.equal((await harbor.proof('package', 'carol')).artifactVerified, true);
  await harbor.revoke({id: 'research', reason: 'synthetic agreement ended'}, 'alice');
  await assert.rejects(harbor.fetchRelease('package', 'carol'), error => error.kind === 'release_revoked');
  assert.equal((await harbor.verify()).valid, true);
  process.stdout.write(JSON.stringify({accepted: true, offline: true, status: await harbor.status()}) + String.fromCharCode(10));
} finally {
  await rm(root, {recursive: true, force: true});
}
