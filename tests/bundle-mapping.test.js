import test from 'node:test';
import assert from 'node:assert/strict';
import {Harbor} from '../src/service.js';
import {tempRoot, startServer, buildManifest, registerDatasets} from '../tests/bundle-support.js';

test('bundle mapping converts supplier columns into the local schema', async t => {
  const root = await tempRoot(t);
  const harbor = new Harbor(root);
  await registerDatasets(harbor);
  // Supplier uses different column names for enrollments.
  const rawEnroll = '[{"enrollment_id":"E1","course_code":"C1","clock_hours":12}]';
  const coursesBody = '[{"code":"C1","name":"测量课程"}]';
  const manifest = buildManifest('rel-map', [
    {dataset: 'courses', body: coursesBody},
    {dataset: 'enrollments', body: rawEnroll,
      dependencies: [{dataset: 'courses', member_version: 'v1'}]},
  ]);
  const payloads = {courses: coursesBody, enrollments: rawEnroll};
  const routes = manifest.members.map(m => ({path: m.url,
    responses: [{body: payloads[m.dataset], headers: {'Content-Type': 'application/json'}}]}));
  routes.unshift({path: '/manifest', responses: [{json: manifest}]});
  const {server, base} = await startServer(routes);
  t.after(() => server.close());

  await harbor.planBundle({id: 'bm', manifest, baseUrl: base, mapping: {
    enrollments: [
      {target: 'id', source: 'enrollment_id'},
      {target: 'course', source: 'course_code'},
      {target: 'hours', source: 'clock_hours'},
    ],
  }}, 'alice');
  const ingest = await harbor.ingestBundle({id: 'bm'}, 'alice');
  assert.equal(ingest.bundle.state, 'verified');
  await harbor.activateBundle({id: 'bm'}, 'alice');
  const rows = await harbor.rows({reference: 'enrollments:1'}, 'alice');
  assert.deepEqual(rows.rows[0], {id: 'E1', course: 'C1', hours: 12});
  assert.equal((await harbor.verify()).valid, true);
});
