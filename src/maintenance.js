import {promises as fs} from 'node:fs';
import path from 'node:path';
import {Vault} from './vault.js';
import {checksum, encode, decode, demand, fields, count} from './primitives.js';
import {referencedObjects, verifyVault} from './integrity.js';

export async function orphanReport(vault, index) {
  const referenced = referencedObjects(index);
  const files = await fs.readdir(path.join(vault.root, 'objects'));
  const orphaned = [];
  let retainedBytes = 0;
  for (const name of files.sort()) {
    demand(/^[a-f0-9]{64}$/.test(name), 'object_filename', 'Unexpected file in object directory');
    const stat = await fs.lstat(path.join(vault.root, 'objects', name));
    demand(stat.isFile() && !stat.isSymbolicLink(), 'unsafe_path', 'Object is not a regular file');
    if (referenced.has(name)) {
      retainedBytes += stat.size;
    } else {
      orphaned.push({hash: name, bytes: stat.size});
    }
  }
  return {generation: index.generation, retained: referenced.size, retainedBytes, orphaned,
    reclaimableBytes: orphaned.reduce((sum, item) => sum + item.bytes, 0)};
}
export async function collectOrphans(vault, input) {
  fields(input, ['expectedGeneration', 'hashes'], ['expectedGeneration', 'hashes']);
  count(input.expectedGeneration, 'expectedGeneration', 0);
  demand(Array.isArray(input.hashes), 'hashes', 'Hashes must be a list');
  return vault.exclusive(async () => {
    const index = await vault.readIndex();
    demand(index.generation === input.expectedGeneration, 'gc_stale', 'Vault changed since orphan preview');
    const report = await orphanReport(vault, index);
    const eligible = new Set(report.orphaned.map(item => item.hash));
    demand(new Set(input.hashes).size === input.hashes.length && input.hashes.every(hash => eligible.has(hash)),
      'gc_reference', 'Collection list contains referenced or unknown object');
    for (const hash of input.hashes) {
      await fs.unlink(path.join(vault.root, 'objects', hash));
    }
    return {removed: input.hashes.length, hashes: input.hashes};
  });
}
export async function backupVault(vault, destination) {
  return vault.exclusive(async () => {
    const index = await vault.readIndex();
    const verification = await verifyVault(vault, index);
    demand(verification.valid, 'backup_integrity', 'Vault failed integrity check', verification);
    demand(path.resolve(destination) !== vault.root, 'backup_path', 'Backup destination must differ from vault');
    await fs.mkdir(destination, {recursive: false, mode: 0o700});
    const files = [];
    const head = path.join(vault.root, 'HEAD');
    if (index.generation > 0) {
      const pointer = decode(await fs.readFile(head, 'utf8'));
      const name = `${pointer.generation}-${pointer.checksum}.json`;
      await fs.mkdir(path.join(destination, 'generations'));
      await fs.copyFile(head, path.join(destination, 'HEAD'));
      files.push('HEAD');
      await fs.copyFile(path.join(vault.root, 'generations', name), path.join(destination, 'generations', name));
      files.push(`generations/${name}`);
    }
    await fs.mkdir(path.join(destination, 'objects'));
    for (const hash of referencedObjects(index).keys()) {
      await fs.copyFile(path.join(vault.root, 'objects', hash), path.join(destination, 'objects', hash));
      files.push(`objects/${hash}`);
    }
    try {
      await fs.copyFile(path.join(vault.root, 'tokenization.key'), path.join(destination, 'tokenization.key'));
      await fs.chmod(path.join(destination, 'tokenization.key'), 0o600);
      files.push('tokenization.key');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
    const manifest = {format: 1, generation: index.generation, files: []};
    for (const file of files.sort()) {
      const bytes = await fs.readFile(path.join(destination, file));
      manifest.files.push({path: file, checksum: checksum(bytes), bytes: bytes.length});
    }
    await fs.writeFile(path.join(destination, 'backup.json'), encode(manifest), {mode: 0o600});
    return {generation: index.generation, files: manifest.files.length, manifestChecksum: checksum(manifest)};
  });
}
export async function verifyBackup(root) {
  const manifest = decode(await fs.readFile(path.join(root, 'backup.json'), 'utf8'));
  demand(manifest.format === 1 && Array.isArray(manifest.files), 'backup_format', 'Backup format is invalid');
  const seen = new Set();
  for (const entry of manifest.files) {
    demand(typeof entry.path === 'string' && new RegExp('^(HEAD|tokenization[.]key|objects/[a-f0-9]{64}|generations/[0-9]+-[a-f0-9]{64}[.]json)$').test(entry.path),
      'backup_path', 'Backup contains unsafe file path');
    demand(!seen.has(entry.path), 'backup_duplicate', 'Backup repeats a file');
    seen.add(entry.path);
    const file = path.join(root, entry.path);
    const stat = await fs.lstat(file);
    demand(stat.isFile() && !stat.isSymbolicLink(), 'backup_link', 'Backup file is not regular');
    const bytes = await fs.readFile(file);
    demand(bytes.length === entry.bytes && checksum(bytes) === entry.checksum, 'backup_checksum', 'Backup file differs', {path: entry.path});
  }
  const vault = new Vault(root);
  const index = await vault.readIndex();
  demand(index.generation === manifest.generation, 'backup_generation', 'Backup generation differs');
  const checked = await verifyVault(vault, index);
  demand(checked.valid, 'backup_integrity', 'Backup references are broken', checked);
  return {manifest, verified: true};
}
export async function restoreVault(source, destination) {
  const {manifest} = await verifyBackup(source);
  await fs.mkdir(destination, {recursive: false, mode: 0o700});
  try {
    await fs.mkdir(path.join(destination, 'objects'));
    await fs.mkdir(path.join(destination, 'generations'));
    for (const entry of manifest.files) {
      await fs.copyFile(path.join(source, entry.path), path.join(destination, entry.path));
      await fs.chmod(path.join(destination, entry.path), 0o600);
    }
    const vault = new Vault(destination);
    const index = await vault.readIndex();
    demand((await verifyVault(vault, index)).valid, 'restore_integrity', 'Restored vault failed verification');
    return {restored: true, generation: index.generation};
  } catch (error) {
    await fs.rm(destination, {recursive: true, force: true});
    throw error;
  }
}
