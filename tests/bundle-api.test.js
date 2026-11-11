import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile, rm} from 'node:fs/promises';
import path from 'node:path';
import {Harbor} from '../src/service.js';
import {serve} from '../src/api.js';
import {runCommand} from '../src/main.js';
import {
  tempRoot, startServer, routesFor, coursesManifest, registerDatasets,
} from './bundle-support.js';

async function harness(t) {
  const root = await tempRoot(t);
  const harbor = new Harbor(root);
  await registerDatasets(harbor);
  const manifest = coursesManifest();
  const {server, base} = await startServer(routesFor(manifest));
  t.after(() => server.close());
  const api = await serve(harbor, {port: 0, token: 'synthetic-api-token'});
  t.after(() => new Promise(resolve => api.close(resolve)));
  const apiBase = `http://127.0.0.1:${api.address().port}`;
  return {harbor, root, base, manifest, apiBase};
}

test('HTTP API drives plan, ingest and activate with bearer token and actor', async t => {
  const {base, manifest, apiBase} = await harness(t);
  const headers = {authorization: 'Bearer synthetic-api-token', 'x-actor': 'alice',
    'content-type': 'application/json'};

  const preview = await fetch(`${apiBase}/bundles/preview`, {method: 'POST', headers,
    body: JSON.stringify({manifest, baseUrl: base})});
  assert.equal(preview.status, 200);
  assert.equal((await preview.json()).ready, true);

  const plan = await fetch(`${apiBase}/bundles/plan`, {method: 'POST', headers,
    body: JSON.stringify({id: 'b1', manifest, baseUrl: base})});
  assert.equal(plan.status, 200);
  const planned = await plan.json();
  assert.equal(planned.bundle.state, 'planned');

  const ingest = await fetch(`${apiBase}/bundles/ingest`, {method: 'POST', headers,
    body: JSON.stringify({id: 'b1'})});
  assert.equal(ingest.status, 200);
  assert.equal((await ingest.json()).bundle.state, 'verified');

  const activate = await fetch(`${apiBase}/bundles/activate`, {method: 'POST', headers,
    body: JSON.stringify({id: 'b1'})});
  const activated = await activate.json();
  assert.equal(activate.status, 200);
  assert.equal(activated.switches.length, 2);

  const status = await fetch(`${apiBase}/bundle?id=b1`, {headers});
  assert.equal((await status.json()).state, 'activated');

  const list = await fetch(`${apiBase}/bundles`, {headers});
  assert.equal((await list.json()).bundles[0].id, 'b1');

  const trace = await fetch(`${apiBase}/bundle/trace?reference=enrollments:1`, {headers});
  const traced = await trace.json();
  assert.equal(traced.bundle.id, 'b1');
});

test('HTTP API enforces optimistic generation via If-Match on activation', async t => {
  const {base, manifest, apiBase, harbor} = await harness(t);
  const headers = {authorization: 'Bearer synthetic-api-token', 'x-actor': 'alice',
    'content-type': 'application/json'};
  await fetch(`${apiBase}/bundles/plan`, {method: 'POST', headers,
    body: JSON.stringify({id: 'b1', manifest, baseUrl: base})});
  await fetch(`${apiBase}/bundles/ingest`, {method: 'POST', headers, body: JSON.stringify({id: 'b1'})});
  const staleGeneration = (await harbor.catalog()).generation;
  await harbor.import({dataset: 'courses', importId: 'side', rows: [{code: 'Z', name: '旁路'}]}, 'alice');
  const rejected = await fetch(`${apiBase}/bundles/activate`, {method: 'POST',
    headers: {...headers, 'if-match': String(staleGeneration)}, body: JSON.stringify({id: 'b1'})});
  assert.equal(rejected.status, 409);
  assert.equal((await rejected.json()).error, 'stale');
});

test('HTTP API rejects bundle writes without a valid actor', async t => {
  const {base, manifest, apiBase} = await harness(t);
  const noActor = await fetch(`${apiBase}/bundles/plan`, {method: 'POST',
    headers: {authorization: 'Bearer synthetic-api-token', 'content-type': 'application/json'},
    body: JSON.stringify({id: 'b1', manifest, baseUrl: base})});
  assert.equal(noActor.status, 400);
  const noToken = await fetch(`${apiBase}/bundles`, {headers: {'x-actor': 'alice'}});
  assert.equal(noToken.status, 401);
});

test('CLI bundle commands operate on a real vault and expose status and trace', async t => {
  const {root, base, manifest} = await harness(t);
  const input = path.join(root, 'plan.json');
  await writeFile(input, JSON.stringify({id: 'cli-1', manifest, baseUrl: base}));
  const plan = await runCommand(['bundle-plan', '--root', root, '--actor', 'alice', '--input', input]);
  assert.equal(plan.ready, true);

  const ingestInput = path.join(root, 'ingest.json');
  await writeFile(ingestInput, JSON.stringify({id: 'cli-1'}));
  const ingest = await runCommand(['bundle-ingest', '--root', root, '--actor', 'alice', '--input', ingestInput]);
  assert.equal(ingest.bundle.state, 'verified');

  const activated = await runCommand(['bundle-activate', '--root', root, '--actor', 'alice', '--input', ingestInput]);
  assert.equal(activated.switches.length, 2);

  const status = await runCommand(['bundle-status', '--root', root, '--id', 'cli-1']);
  assert.equal(status.state, 'activated');

  const list = await runCommand(['bundles', '--root', root]);
  assert.equal(list.bundles[0].id, 'cli-1');

  const traceInput = path.join(root, 'trace.json');
  await writeFile(traceInput, JSON.stringify({reference: 'courses:1'}));
  const trace = await runCommand(['bundle-trace', '--root', root, '--input', traceInput]);
  assert.equal(trace.bundle.id, 'cli-1');

  // help advertises the new commands.
  const help = await runCommand(['help']);
  for (const command of ['bundle-plan', 'bundle-ingest', 'bundle-activate', 'bundle-status', 'bundle-trace']) {
    assert.ok(help.commands.includes(command));
  }
  await rm(input, {force: true});
});

test('CLI preview surfaces diagnostic problems without creating a bundle', async t => {
  const {root, base, manifest} = await harness(t);
  const changed = JSON.parse(JSON.stringify(manifest));
  changed.members[0].schema_revision = 5;
  const input = path.join(root, 'preview.json');
  await writeFile(input, JSON.stringify({manifest: changed, baseUrl: base}));
  const preview = await runCommand(['bundle-preview', '--root', root, '--actor', 'alice', '--input', input]);
  assert.equal(preview.ready, false);
  assert.ok(preview.problems.some(problem => problem.code === 'schema_revision_mismatch'));
  const list = await runCommand(['bundles', '--root', root]);
  assert.equal(list.bundles.length, 0);
  await rm(input, {force: true});
});
