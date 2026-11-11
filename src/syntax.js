import {readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
let checked = 0;
for (const directory of ['src', 'tests']) {
  for (const name of await readdir(directory)) {
    if (!name.endsWith('.js')) {
      continue;
    }
    const file = path.join(directory, name);
    const result = spawnSync(process.execPath, ['--check', file], {encoding: 'utf8'});
    if (result.status !== 0) {
      process.stderr.write(result.stderr);
      process.exit(result.status ?? 1);
    }
    checked += 1;
  }
}
process.stdout.write(JSON.stringify({syntaxChecked: checked}) + String.fromCharCode(10));
