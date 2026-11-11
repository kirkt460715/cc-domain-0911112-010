import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomBytes, randomUUID} from 'node:crypto';
import {setTimeout as wait} from 'node:timers/promises';
import {checksum, decode, demand, encode, changed} from './primitives.js';

export function blankIndex() {
  return {
    format: 1,
    generation: 0,
    organizations: {},
    datasets: {},
    versions: {},
    grants: {},
    requests: {},
    releases: {},
    audits: [],
  };
}
async function regular(file) {
  const stat = await fs.lstat(file);
  demand(stat.isFile() && !stat.isSymbolicLink(), 'unsafe_path', 'Expected a regular vault file');
  return stat;
}
async function durable(file, data) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, file);
    const directory = await fs.open(path.dirname(file), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await fs.rm(temporary, {force: true});
    throw error;
  }
}
export class Vault {
  constructor(root, options = {}) {
    this.root = path.resolve(root);
    this.timeout = options.timeout ?? 5000;
  }
  async open() {
    await fs.mkdir(this.root, {recursive: true, mode: 0o700});
    const stat = await fs.lstat(this.root);
    demand(stat.isDirectory() && !stat.isSymbolicLink(), 'unsafe_path', 'Vault root cannot be a link');
    for (const name of ['objects', 'generations']) {
      const directory = path.join(this.root, name);
      await fs.mkdir(directory, {recursive: true, mode: 0o700});
      demand(!(await fs.lstat(directory)).isSymbolicLink(), 'unsafe_path', 'Vault subdirectory cannot be a link');
    }
    return this;
  }
  async exclusive(action) {
    await this.open();
    const lock = path.join(this.root, 'commit.lock');
    const until = Date.now() + this.timeout;
    const owner = randomUUID();
    let handle;
    while (!handle) {
      try {
        handle = await fs.open(lock, 'wx', 0o600);
      } catch (error) {
        if (error.code !== 'EEXIST') {
          throw error;
        }
        demand(Date.now() < until, 'busy', 'Vault has an active commit lock', {}, 409);
        await wait(20);
      }
    }
    try {
      await handle.writeFile(encode({owner, pid: process.pid}));
      await handle.sync();
      return await action();
    } finally {
      await handle.close();
      const current = decode(await fs.readFile(lock, 'utf8'));
      if (current.owner === owner) {
        await fs.unlink(lock);
      }
    }
  }
  async readIndex() {
    const pointer = path.join(this.root, 'HEAD');
    let head;
    try {
      await regular(pointer);
      head = decode(await fs.readFile(pointer, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') {
        return blankIndex();
      }
      throw error;
    }
    demand(Number.isSafeInteger(head.generation) && head.generation > 0 && /^[a-f0-9]{64}$/.test(head.checksum),
      'head', 'Vault head is malformed');
    const file = path.join(this.root, 'generations', `${head.generation}-${head.checksum}.json`);
    await regular(file);
    const raw = await fs.readFile(file, 'utf8');
    demand(checksum(raw) === head.checksum, 'index_checksum', 'Vault generation checksum differs');
    const index = decode(raw);
    demand(index.generation === head.generation && index.format === 1, 'index', 'Vault generation is incompatible');
    return index;
  }
  async snapshot() {
    return this.exclusive(() => this.readIndex());
  }
  async update(actor, operation, work, expected) {
    return this.exclusive(async () => {
      const before = await this.readIndex();
      changed(expected, before.generation);
      const next = structuredClone(before);
      const outcome = await work(next);
      if (outcome.noChange) {
        return {...outcome.result, generation: before.generation, committed: false};
      }
      next.generation += 1;
      const previousAudit = next.audits.at(-1)?.checksum ?? '0'.repeat(64);
      const audit = {generation: next.generation, actor, operation, previous: previousAudit,
        details: outcome.audit ?? {}, at: new Date().toISOString()};
      next.audits.push({...audit, checksum: checksum(audit)});
      const encoded = encode(next);
      const hash = checksum(encoded);
      const file = path.join(this.root, 'generations', `${next.generation}-${hash}.json`);
      await durable(file, encoded);
      await durable(path.join(this.root, 'HEAD'), encode({generation: next.generation, checksum: hash}));
      return {...outcome.result, generation: next.generation, committed: true};
    });
  }
  async putObject(value) {
    const raw = typeof value === 'string' ? value : encode(value);
    const hash = checksum(raw);
    const file = path.join(this.root, 'objects', hash);
    try {
      const handle = await fs.open(file, 'wx', 0o600);
      try {
        await handle.writeFile(raw);
        await handle.sync();
      } finally {
        await handle.close();
      }
      const directory = await fs.open(path.dirname(file), 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
      demand(await this.getObject(hash) === raw, 'object_collision', 'Existing object content differs');
    }
    return {hash, bytes: Buffer.byteLength(raw)};
  }
  async getObject(hash) {
    demand(typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash), 'object_id', 'Invalid object identifier');
    const file = path.join(this.root, 'objects', hash);
    await regular(file);
    const raw = await fs.readFile(file, 'utf8');
    demand(checksum(raw) === hash, 'object_checksum', 'Object integrity check failed', {hash});
    return raw;
  }
  async getRows(hash) {
    const value = decode(await this.getObject(hash));
    demand(Array.isArray(value), 'object_type', 'Object is not a table');
    return value;
  }
  async secret() {
    const file = path.join(this.root, 'tokenization.key');
    try {
      await regular(file);
      const secret = await fs.readFile(file);
      demand(secret.length === 32, 'key_corrupt', 'Local tokenization key must be 32 bytes');
      return secret;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      const secret = randomBytes(32);
      const handle = await fs.open(file, 'wx', 0o600);
      try {
        await handle.writeFile(secret);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return secret;
    }
  }
  async recoverLock() {
    await this.open();
    const file = path.join(this.root, 'commit.lock');
    let lock;
    try {
      lock = decode(await fs.readFile(file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') {
        return {recovered: false};
      }
      throw error;
    }
    demand(Number.isSafeInteger(lock.pid) && lock.pid > 0 && typeof lock.owner === 'string',
      'lock_corrupt', 'Lock ownership is unknown');
    try {
      process.kill(lock.pid, 0);
    } catch (error) {
      demand(error.code === 'ESRCH', 'lock_unknown', 'Cannot establish whether owner is alive');
      const current = decode(await fs.readFile(file, 'utf8'));
      demand(current.owner === lock.owner, 'lock_changed', 'Lock changed during recovery');
      await fs.unlink(file);
      return {recovered: true};
    }
    demand(false, 'lock_live', 'Cannot recover a live process lock');
  }
}
