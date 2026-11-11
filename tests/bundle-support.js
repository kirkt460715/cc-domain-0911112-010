import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {checksum} from '../src/primitives.js';
import {makeServer} from '../synthetic_exchange/server.js';

export function digest(content) {
  return checksum(Buffer.from(content, 'utf8'));
}

// Build a manifest document whose sha256/bytes match the supplied payloads.
export function buildManifest(releaseId, members) {
  return {
    release_id: releaseId,
    members: members.map(member => ({
      dataset: member.dataset,
      member_version: member.memberVersion ?? 'v1',
      schema_revision: member.schemaRevision ?? 1,
      url: member.url ?? `/data/${member.dataset}`,
      sha256: digest(member.body),
      bytes: Buffer.byteLength(member.body),
      dependencies: member.dependencies ?? [],
    })),
  };
}

// Courses/enrollments payloads used across the suite.
export const COURSES_BODY = '[{"code":"C1","name":"测量课程"},{"code":"C2","name":"安全课程"}]';
export const ENROLL_BODY = '[{"id":"E1","course":"C1","hours":12},{"id":"E2","course":"C2","hours":8}]';

export function coursesManifest(releaseId = 'release-01', overrides = {}) {
  return buildManifest(releaseId, [
    {dataset: 'courses', body: overrides.courses ?? COURSES_BODY},
    {dataset: 'enrollments', body: overrides.enrollments ?? ENROLL_BODY,
      dependencies: [{dataset: 'courses', member_version: 'v1'}]},
  ]);
}

export function routesFor(manifest, payloads = {}) {
  const byDataset = Object.fromEntries(manifest.members.map(member => [member.dataset, member]));
  const payload = {
    courses: payloads.courses ?? COURSES_BODY,
    enrollments: payloads.enrollments ?? ENROLL_BODY,
    ...payloads,
  };
  const routes = [{path: '/manifest', responses: [{json: manifest}]}];
  for (const [dataset, member] of Object.entries(byDataset)) {
    const responses = member._responses ?? [{body: payload[dataset], headers: {'Content-Type': 'application/json'}}];
    routes.push({path: member.url, responses});
  }
  return routes;
}

export async function startServer(routes) {
  const server = makeServer({routes});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {server, base: `http://127.0.0.1:${server.address().port}`};
}

export async function tempRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bundle-test-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  return root;
}

// Register the two datasets with a courses -> enrollments foreign key.
export async function registerDatasets(harbor, {enrollSchemaExtra} = {}) {
  await harbor.organization({id: 'local', name: 'Synthetic institute', region: 'south',
    purposes: ['training'], stewards: ['alice', 'bob']}, 'bootstrap');
  await harbor.dataset({id: 'courses', name: 'Course dictionary', owner: 'local', schema: {
    columns: [{name: 'code', type: 'string', classification: 'public'},
      {name: 'name', type: 'string', classification: 'public'}], primaryKey: ['code']}}, 'alice');
  await harbor.dataset({id: 'enrollments', name: 'Enrollments', owner: 'local', schema: {
    columns: [{name: 'id', type: 'string', classification: 'public'},
      {name: 'course', type: 'string', classification: 'public'},
      {name: 'hours', type: 'integer', classification: 'public', minimum: 0}],
    primaryKey: ['id'],
    foreignKeys: [{columns: ['course'], target: 'courses', targetColumns: ['code']}],
    ...enrollSchemaExtra}}, 'alice');
}

export async function planAndIngest(harbor, manifest, base, {id = 'b1', actor = 'alice', headers} = {}) {
  await harbor.planBundle({id, manifest, baseUrl: base, headers}, actor);
  return harbor.ingestBundle({id}, actor);
}

export async function fullBundle(harbor, manifest, base, options = {}) {
  const ingest = await planAndIngest(harbor, manifest, base, options);
  const actor = options.actor ?? 'alice';
  const id = options.id ?? 'b1';
  const activated = await harbor.activateBundle({id}, actor);
  return {ingest, activated};
}
