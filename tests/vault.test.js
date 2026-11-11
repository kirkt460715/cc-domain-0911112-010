import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile, appendFile, readdir, access} from 'node:fs/promises';
import path from 'node:path';
import {Harbor} from '../src/service.js';
import {Vault} from '../src/vault.js';
import {checksum, encode} from '../src/primitives.js';
import {verifyBackup, restoreVault} from '../src/maintenance.js';
import {setup, rows, grant, request, approved, kind} from './support.js';

test('immutable generations survive reopening and concurrent imports use unique versions', async t => {
  const {harbor, root, clock} = await setup(t);
  const second = new Harbor(root, {clock});
  const results = await Promise.all([
    harbor.import({dataset: 'people', importId: 'parallel-a', rows: [rows()[0]]}, 'alice'),
    second.import({dataset: 'people', importId: 'parallel-b', rows: [rows()[1]]}, 'bob'),
  ]);
  assert.deepEqual(results.map(result => result.version.version).sort(), [2, 3]);
  assert.equal(new Set(results.map(result => result.generation)).size, 2);
  const reopened = new Harbor(root, {clock});
  assert.equal((await reopened.catalog()).versions.length, 3);
  assert.equal((await reopened.verify()).valid, true);
  const generations = await readdir(path.join(root, 'generations'));
  assert.equal(generations.length, (await reopened.status()).generation);
  const head = JSON.parse(await readFile(path.join(root, 'HEAD'), 'utf8'));
  assert.equal(head.generation, (await reopened.status()).generation);
});

test('aborted mutation leaves published generation unchanged', async t => {
  const {harbor} = await setup(t);
  const before = await harbor.catalog();
  await assert.rejects(harbor.vault.update('alice', 'failure', async index => {
    index.datasets.people.name = 'not committed';
    await harbor.vault.putObject({uncommitted: true});
    throw new Error('simulated failure before commit');
  }), /simulated failure/);
  assert.deepEqual(await harbor.catalog(), before);
  const index = await harbor.vault.snapshot();
  assert.equal(index.datasets.people.name, 'Synthetic participation');
  assert.equal((await harbor.orphans()).orphaned.length, 1);
  assert.equal((await harbor.verify()).valid, true);
});

test('orphan collection is generation-bound and never removes referenced objects', async t => {
  const {harbor} = await setup(t);
  const orphan = await harbor.vault.putObject({synthetic: 'unused'});
  const preview = await harbor.orphans();
  assert.ok(preview.orphaned.some(item => item.hash === orphan.hash));
  const index = await harbor.vault.snapshot();
  const used = index.versions['people:1'].object;
  await assert.rejects(harbor.collect({expectedGeneration: preview.generation, hashes: [used]}), kind('gc_reference'));
  await harbor.grant(grant(), 'alice');
  await assert.rejects(harbor.collect({expectedGeneration: preview.generation, hashes: [orphan.hash]}), kind('gc_stale'));
  const current = await harbor.orphans();
  assert.equal((await harbor.collect({expectedGeneration: current.generation, hashes: [orphan.hash]})).removed, 1);
  assert.equal((await harbor.orphans()).orphaned.length, 0);
  assert.equal((await harbor.verify()).valid, true);
});

test('object corruption is detected on reads and full verification', async t => {
  const {harbor, root} = await setup(t);
  const index = await harbor.vault.snapshot();
  const hash = index.versions['people:1'].object;
  await appendFile(path.join(root, 'objects', hash), 'tampered');
  await assert.rejects(harbor.rows({reference: 'people:1'}, 'alice'), kind('object_checksum'));
  const verified = await harbor.verify();
  assert.equal(verified.valid, false);
  assert.ok(verified.failures.some(issue => issue.code === 'object_unreadable'));
  assert.ok(verified.failures.some(issue => issue.code === 'table_unreadable'));
  assert.equal((await harbor.catalog()).versions[0].rows, 3);
});

test('generation checksum prevents corrupted state from being treated as valid', async t => {
  const {harbor, root} = await setup(t);
  const head = JSON.parse(await readFile(path.join(root, 'HEAD'), 'utf8'));
  const file = path.join(root, 'generations', `${head.generation}-${head.checksum}.json`);
  const state = JSON.parse(await readFile(file, 'utf8'));
  state.datasets.people.current = null;
  await writeFile(file, JSON.stringify(state));
  await assert.rejects(harbor.status(), kind('index_checksum'));
  await assert.rejects(harbor.import({dataset: 'people', importId: 'new', rows: rows()}, 'alice'), kind('index_checksum'));
  assert.equal(JSON.parse(await readFile(path.join(root, 'HEAD'), 'utf8')).checksum, head.checksum);
});

test('unreferenced higher generation never replaces committed HEAD after interruption', async t => {
  const {harbor, root} = await setup(t);
  const before = await harbor.catalog();
  const index = await harbor.vault.snapshot();
  index.generation += 1;
  index.datasets.people.name = 'orphan generation';
  const encoded = encode(index);
  await writeFile(path.join(root, 'generations', `${index.generation}-${checksum(encoded)}.json`), encoded);
  assert.deepEqual(await harbor.catalog(), before);
  assert.equal((await harbor.vault.snapshot()).datasets.people.name, 'Synthetic participation');
  assert.equal((await harbor.verify()).valid, true);
});

test('live and malformed commit locks are preserved for explicit recovery', async t => {
  const {root} = await setup(t);
  const lock = path.join(root, 'commit.lock');
  await writeFile(lock, JSON.stringify({owner: 'live', pid: process.pid}));
  const vault = new Vault(root, {timeout: 20});
  await assert.rejects(vault.snapshot(), kind('busy'));
  await assert.rejects(vault.recoverLock(), kind('lock_live'));
  assert.equal(JSON.parse(await readFile(lock, 'utf8')).owner, 'live');
  await writeFile(lock, JSON.stringify({owner: 'unknown'}));
  await assert.rejects(vault.recoverLock(), kind('lock_corrupt'));
  assert.equal(JSON.parse(await readFile(lock, 'utf8')).owner, 'unknown');
});

test('backup preserves tokenization identity and restores usable releases', async t => {
  const {harbor, root, clock} = await setup(t);
  await approved(harbor);
  await harbor.release({id: 'r', request: 'q'}, 'alice');
  const original = await harbor.fetchRelease('r', 'carol');
  const backup = path.join(root, 'backup');
  const result = await harbor.backup(backup);
  assert.equal(result.generation, (await harbor.status()).generation);
  assert.equal((await verifyBackup(backup)).verified, true);
  const destination = path.join(root, 'restored');
  const restored = await restoreVault(backup, destination);
  assert.equal(restored.restored, true);
  const recovered = new Harbor(destination, {clock});
  assert.equal((await recovered.fetchRelease('r', 'carol')).content, original.content);
  await recovered.request(request({id: 'q2'}), 'carol');
  assert.equal((await recovered.vault.snapshot()).requests.q2.outputHash, original.manifest.outputHash);
  assert.equal((await recovered.verify()).valid, true);
  assert.equal((await harbor.status()).generation, result.generation);
});

test('backup tampering blocks restore before destination is created', async t => {
  const {harbor, root} = await setup(t);
  const backup = path.join(root, 'backup');
  await harbor.backup(backup);
  await appendFile(path.join(backup, 'HEAD'), 'bad');
  await assert.rejects(verifyBackup(backup), kind('backup_checksum'));
  const target = path.join(root, 'failed-restore');
  await assert.rejects(restoreVault(backup, target), kind('backup_checksum'));
  await assert.rejects(access(target), error => error.code === 'ENOENT');
  assert.equal((await harbor.verify()).valid, true);
});

test('restore refuses an occupied target without altering existing files', async t => {
  const {harbor, root} = await setup(t);
  const backup = path.join(root, 'backup');
  await harbor.backup(backup);
  const head = await readFile(path.join(root, 'HEAD'), 'utf8');
  await assert.rejects(restoreVault(backup, root), error => error.code === 'EEXIST');
  assert.equal(await readFile(path.join(root, 'HEAD'), 'utf8'), head);
  assert.equal((await harbor.verify()).valid, true);
  assert.equal((await verifyBackup(backup)).verified, true);
});

test('audit-chain tampering is caught even with a recomputed index checksum', async t => {
  const {harbor, root} = await setup(t);
  const index = await harbor.vault.snapshot();
  index.audits[0].actor = 'tampered';
  const raw = encode(index);
  const hash = checksum(raw);
  await writeFile(path.join(root, 'generations', `${index.generation}-${hash}.json`), raw);
  await writeFile(path.join(root, 'HEAD'), encode({generation: index.generation, checksum: hash}));
  const verification = await harbor.verify();
  assert.equal(verification.valid, false);
  assert.ok(verification.failures.some(issue => issue.code === 'audit_chain'));
  assert.equal(verification.generation, index.generation);
});
