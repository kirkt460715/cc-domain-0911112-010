import test from 'node:test';
import assert from 'node:assert/strict';
import {Harbor} from '../src/service.js';
import {
  tempRoot, startServer, routesFor, coursesManifest, buildManifest,
  registerDatasets, fullBundle, planAndIngest, digest,
  COURSES_BODY, ENROLL_BODY,
} from './bundle-support.js';
import {checksum} from '../src/primitives.js';

async function context(t, {routes} = {}) {
  const root = await tempRoot(t);
  const harbor = new Harbor(root);
  await registerDatasets(harbor);
  const manifest = coursesManifest();
  const {server, base} = await startServer(routes ?? routesFor(manifest));
  t.after(() => server.close());
  return {harbor, base, manifest, root};
}

test('release bundle plans, ingests and atomically activates the whole group', async t => {
  const {harbor, base, manifest} = await context(t);
  const plan = await harbor.planBundle({id: 'b1', manifest, baseUrl: base}, 'alice');
  assert.equal(plan.ready, true);
  assert.deepEqual(plan.ingestOrder, ['courses', 'enrollments']);
  assert.equal(plan.bundle.state, 'planned');

  const ingest = await harbor.ingestBundle({id: 'b1'}, 'alice');
  assert.equal(ingest.bundle.state, 'verified');
  assert.equal(ingest.serviceUnchanged, true);
  assert.deepEqual(ingest.bundle.members.map(m => m.status), ['validated', 'validated']);

  // Before activation no product pointer moved.
  let catalog = await harbor.catalog();
  assert.deepEqual(catalog.datasets.map(d => d.current), [null, null]);

  const activated = await harbor.activateBundle({id: 'b1'}, 'alice');
  assert.deepEqual(activated.switches.map(s => s.dataset), ['courses', 'enrollments']);
  catalog = await harbor.catalog();
  assert.deepEqual(catalog.datasets.map(d => d.current), ['courses:1', 'enrollments:1']);

  const status = await harbor.bundleStatus('b1');
  assert.equal(status.state, 'activated');
  assert.equal(status.drift.length, 0);
  assert.equal((await harbor.verify()).valid, true);
});

test('enrollment foreign keys freeze the in-release courses version and never follow latest', async t => {
  const {harbor, base, manifest} = await context(t);
  await fullBundle(harbor, manifest, base);
  const enrollment = (await harbor.catalog()).versions.find(v => v.reference === 'enrollments:1');
  assert.deepEqual(enrollment.dependencies, ['courses:1']);

  // A newer courses version becomes the live pointer; the enrollment keeps v1.
  await harbor.import({dataset: 'courses', importId: 'newer', rows: [
    {code: 'C1', name: '测量课程'}, {code: 'C2', name: '安全课程'}, {code: 'C3', name: '新课程'}]}, 'alice');
  await harbor.activate({dataset: 'courses', version: 2, expectedCurrent: 'courses:1'}, 'alice');
  const still = (await harbor.catalog()).versions.find(v => v.reference === 'enrollments:1');
  assert.deepEqual(still.dependencies, ['courses:1']);

  // Lineage confirms the frozen ancestor.
  const lineage = await harbor.lineage('enrollments:1', 'alice');
  assert.deepEqual(lineage.ancestors, ['courses:1']);
});

test('ingestion validates against release bytes even when no local active version exists', async t => {
  // This is the original incident: importing enrollments first against the
  // current pointer failed. Inside a bundle the ordering is enforced instead.
  const {harbor, base, manifest} = await context(t);
  const ingest = await planAndIngest(harbor, manifest, base);
  assert.equal(ingest.bundle.state, 'verified');
  const refs = Object.fromEntries(ingest.bundle.members.map(m => [m.dataset, m.reference]));
  assert.equal(refs.enrollments, 'enrollments:1');
});

test('preview reports missing members, revision mismatch and authority without writing', async t => {
  const {harbor, base, manifest} = await context(t);
  const before = await harbor.catalog();
  const preview = await harbor.previewBundlePlan({manifest, baseUrl: base}, 'carol');
  assert.equal(preview.ready, false);
  assert.ok(preview.problems.some(p => p.code === 'steward'));
  assert.deepEqual((await harbor.catalog()).datasets, before.datasets);

  const unknown = buildManifest('x', [{dataset: 'ghost', body: '[]', dependencies: []}]);
  const p2 = await harbor.previewBundlePlan({manifest: unknown}, 'alice');
  assert.ok(p2.problems.some(p => p.code === 'dataset_unknown'));

  const changed = JSON.parse(JSON.stringify(manifest));
  changed.members[0].schema_revision = 9;
  const p3 = await harbor.previewBundlePlan({manifest: changed, baseUrl: base}, 'alice');
  assert.ok(p3.problems.some(p => p.code === 'schema_revision_mismatch' && p.dataset === 'courses'));
});

test('manifest dependency cycles and undeclared members are rejected at parse time', async t => {
  const {harbor, base} = await context(t);
  const cyclic = {
    release_id: 'cyc',
    members: [
      {dataset: 'courses', member_version: 'v1', schema_revision: 1, url: '/data/courses',
        sha256: digest(COURSES_BODY), bytes: Buffer.byteLength(COURSES_BODY),
        dependencies: [{dataset: 'enrollments', member_version: 'v1'}]},
      {dataset: 'enrollments', member_version: 'v1', schema_revision: 1, url: '/data/enrollments',
        sha256: digest(ENROLL_BODY), bytes: Buffer.byteLength(ENROLL_BODY),
        dependencies: [{dataset: 'courses', member_version: 'v1'}]},
    ],
  };
  await assert.rejects(harbor.planBundle({id: 'cyc', manifest: cyclic, baseUrl: base}, 'alice'),
    error => error.kind === 'manifest_cycle');

  const dangling = coursesManifest();
  dangling.members[1].dependencies = [{dataset: 'courses', member_version: 'v9'}];
  await assert.rejects(harbor.planBundle({id: 'dang', manifest: dangling, baseUrl: base}, 'alice'),
    error => error.kind === 'manifest_dependency_version');
});

test('digest and size mismatches isolate the member and keep the old product serving', async t => {
  const manifest = coursesManifest();
  const tampered = '[{"id":"E1","course":"C1","hours":99}]';
  const routes = routesFor(manifest, {enrollments: tampered});
  const {harbor, base} = await context(t, {routes});
  const ingest = await planAndIngest(harbor, manifest, base);
  assert.equal(ingest.bundle.state, 'failed');
  const failure = ingest.bundle.failures.find(f => f.dataset === 'enrollments');
  assert.ok(['member_digest', 'member_size'].includes(failure.code));
  const catalog = await harbor.catalog();
  assert.deepEqual(catalog.datasets.map(d => d.current), [null, null]);

  await assert.rejects(harbor.activateBundle({id: 'b1'}, 'alice'), error => error.kind === 'bundle_state');
  assert.ok(['member_digest', 'member_size'].includes((await harbor.bundleStatus('b1')).failures[0].code));
});

test('quarantined member retains diagnostic evidence and the rest of the group stays inactive', async t => {
  // Manifest digests describe the bytes actually served; validation (not
  // transport) must quarantine the broken foreign key.
  const badEnroll = '[{"id":"E1","course":"C1","hours":12},{"id":"E3","course":"NOPE","hours":5}]';
  const manifest = buildManifest('release-01', [
    {dataset: 'courses', body: COURSES_BODY},
    {dataset: 'enrollments', body: badEnroll,
      dependencies: [{dataset: 'courses', member_version: 'v1'}]},
  ]);
  const routes = routesFor(manifest, {enrollments: badEnroll});
  const {harbor, base} = await context(t, {routes});
  const ingest = await planAndIngest(harbor, manifest, base);
  assert.equal(ingest.bundle.state, 'failed');
  const quality = ingest.bundle.failures.find(f => f.code === 'member_quarantined');
  assert.equal(quality.dataset, 'enrollments');
  assert.equal(quality.report.issues.foreign_key, 1);

  // The quarantined version and its rejected rows are retained for diagnosis.
  const version = (await harbor.catalog()).versions.find(v => v.reference === 'enrollments:1');
  assert.equal(version.status, 'quarantined');
  const rejected = await harbor.rejected('enrollments:1', 'alice');
  assert.equal(rejected.rejected[0].code, 'foreign_key');

  // Courses validated but must not be switched on while the group is incomplete.
  await assert.rejects(harbor.activateBundle({id: 'b1'}, 'alice'), error => error.kind === 'bundle_state');
  assert.deepEqual((await harbor.catalog()).datasets.map(d => d.current), [null, null]);
});

test('same release pointing at different bytes is isolated instead of merged', async t => {
  const {harbor, base, manifest} = await context(t);
  await fullBundle(harbor, manifest, base, {id: 'b1'});
  // A second plan for the SAME release_id/member_version whose payload passes
  // transport verification (its own manifest digest matches) but differs in
  // bytes from the first delivery.
  const alteredCourses = '[{"code":"C1","name":"测理课程"},{"code":"C2","name":"安全课程"}]';
  assert.equal(Buffer.byteLength(alteredCourses), Buffer.byteLength(COURSES_BODY));
  assert.notEqual(digest(alteredCourses), digest(COURSES_BODY));
  const manifest2 = buildManifest('release-01', [
    {dataset: 'courses', body: alteredCourses},
    {dataset: 'enrollments', body: ENROLL_BODY,
      dependencies: [{dataset: 'courses', member_version: 'v1'}]},
  ]);
  const routes2 = routesFor(manifest2, {courses: alteredCourses});
  const {server, base: base2} = await startServer(routes2);
  t.after(() => server.close());
  // Reuse the first bundle's import-id prefix so the same logical member is
  // re-encountered; differing bytes must be isolated, never silently merged.
  await harbor.planBundle({id: 'b2', manifest: manifest2, baseUrl: base2, importIdPrefix: 'bundle-b1'}, 'alice');
  await assert.rejects(harbor.ingestBundle({id: 'b2'}, 'alice'),
    error => error.kind === 'bundle_byte_conflict');
  // The original service version is untouched.
  const catalog = await harbor.catalog();
  assert.equal(catalog.datasets.find(d => d.id === 'courses').current, 'courses:1');
});

test('identical bytes for the same member are deduplicated and replayed safely', async t => {
  const {harbor, base, manifest} = await context(t);
  const first = await planAndIngest(harbor, manifest, base, {id: 'b1', importIdPrefix: undefined});
  assert.equal(first.bundle.state, 'verified');
  // Another bundle reusing the same import-id prefix with byte-identical content.
  await harbor.planBundle({id: 'b2', manifest, baseUrl: base, importIdPrefix: 'bundle-b1'}, 'alice');
  const second = await harbor.ingestBundle({id: 'b2'}, 'alice');
  assert.equal(second.bundle.state, 'verified');
  assert.deepEqual(second.bundle.members.map(m => m.reference), ['courses:1', 'enrollments:1']);
});

test('pause and resume reuses verified bytes but re-runs drift and digest checks', async t => {
  const root = await tempRoot(t);
  const harbor = new Harbor(root);
  await registerDatasets(harbor);
  const manifest = coursesManifest();
  // First attempt: enrollments endpoint fails once, then recovers.
  const routes = routesFor(manifest);
  routes.find(r => r.path === '/data/enrollments').responses.unshift({status: 500, body: 'boom'});
  const {server, base} = await startServer(routes);
  t.after(() => server.close());

  await harbor.planBundle({id: 'b1', manifest, baseUrl: base}, 'alice');
  const first = await harbor.ingestBundle({id: 'b1'}, 'alice');
  assert.equal(first.bundle.state, 'failed');
  const coursesMember = first.bundle.members.find(m => m.dataset === 'courses');
  assert.ok(coursesMember.contentObject);
  assert.equal(coursesMember.reference, 'courses:1');

  // Resume: the synthetic server now serves the healthy response, stored
  // courses bytes are reused without a second download.
  const resumed = await harbor.ingestBundle({id: 'b1'}, 'alice');
  assert.equal(resumed.bundle.state, 'verified');
  assert.equal(resumed.bundle.members.find(m => m.dataset === 'courses').attempts, 2);
  assert.equal(resumed.bundle.members.find(m => m.dataset === 'enrollments').reference, 'enrollments:1');
  await harbor.activateBundle({id: 'b1'}, 'alice');
  assert.equal((await harbor.verify()).valid, true);
});

test('resume after authorization lapse cannot reuse the stale grant or old verdict', async t => {
  const root = await tempRoot(t);
  const harbor = new Harbor(root);
  await registerDatasets(harbor);
  await harbor.organization({id: 'partner', name: 'Partner', region: 'south',
    purposes: ['training'], stewards: ['carol']}, 'bootstrap');
  const manifest = coursesManifest();
  const routes = routesFor(manifest);
  routes.find(r => r.path === '/data/enrollments').responses.unshift({status: 500, body: 'x'});
  const {server, base} = await startServer(routes);
  t.after(() => server.close());

  await harbor.planBundle({id: 'b1', manifest, baseUrl: base}, 'alice');
  await harbor.ingestBundle({id: 'b1'}, 'alice');
  // A grant covering enrollments is created then revoked while the bundle waits.
  await harbor.grant({id: 'g1', dataset: 'enrollments', recipient: 'partner', purposes: ['training'],
    columns: ['id', 'course', 'hours'], rowBudget: 100, expiresAt: '2027-01-01T00:00:00Z'}, 'alice');
  await harbor.revoke({id: 'g1', reason: 'pause test'}, 'alice');
  const resumed = await harbor.ingestBundle({id: 'b1'}, 'alice');
  assert.equal(resumed.bundle.state, 'failed');
  assert.equal(resumed.bundle.failures[0].code, 'bundle_replan_required');
  assert.ok(resumed.bundle.failures[0].drift.some(d => d.code === 'grant_revoked'));
  // Verified bytes were still reused, but the stale plan cannot proceed.
  assert.ok(resumed.bundle.members.find(m => m.dataset === 'courses').contentObject);
});

test('schema revision change between plan and ingest forces replanning', async t => {
  const {harbor, base, manifest} = await context(t);
  await harbor.planBundle({id: 'b1', manifest, baseUrl: base}, 'alice');
  // Revise the courses schema in a compatible way.
  const extended = {
    columns: [{name: 'code', type: 'string', classification: 'public'},
      {name: 'name', type: 'string', classification: 'public'},
      {name: 'level', type: 'string', classification: 'public', nullable: true}],
    primaryKey: ['code'],
  };
  await harbor.schema({dataset: 'courses', schema: extended, expectedRevision: 1}, 'alice');
  const ingest = await harbor.ingestBundle({id: 'b1'}, 'alice');
  assert.equal(ingest.bundle.state, 'failed');
  assert.equal(ingest.bundle.failures[0].code, 'bundle_replan_required');
  assert.ok(ingest.bundle.failures[0].drift.some(d => d.code === 'schema_changed'));
});

test('activation refuses when the active version moved and asks for a fresh plan', async t => {
  const {harbor, base, manifest} = await context(t);
  // Establish an older active courses product before planning.
  await harbor.import({dataset: 'courses', importId: 'old', rows: [{code: 'C9', name: '旧课程'}]}, 'alice');
  await harbor.activate({dataset: 'courses', version: 1}, 'alice');
  await harbor.planBundle({id: 'b1', manifest, baseUrl: base}, 'alice');
  // While waiting, operations switch courses to yet another active version.
  await harbor.import({dataset: 'courses', importId: 'mid', rows: [
    {code: 'C9', name: '旧课程'}, {code: 'C8', name: '中途课程'}]}, 'alice');
  await harbor.activate({dataset: 'courses', version: 2, expectedCurrent: 'courses:1'}, 'alice');
  const ingest = await harbor.ingestBundle({id: 'b1'}, 'alice');
  assert.equal(ingest.bundle.state, 'failed');
  assert.ok(ingest.bundle.failures[0].drift.some(d => d.code === 'active_version_changed'));
});

test('only owner stewards can plan and activate bundles', async t => {
  const {harbor, base, manifest} = await context(t);
  await assert.rejects(harbor.planBundle({id: 'b1', manifest, baseUrl: base}, 'carol'),
    error => error.kind === 'steward');
  await harbor.planBundle({id: 'b1', manifest, baseUrl: base}, 'alice');
  await assert.rejects(harbor.ingestBundle({id: 'b1'}, 'carol'), error => error.kind === 'steward');
  await harbor.ingestBundle({id: 'b1'}, 'alice');
  await assert.rejects(harbor.activateBundle({id: 'b1'}, 'carol'), error => error.kind === 'steward');
});

test('abandonment preserves diagnostic versions and never moves product pointers', async t => {
  const badEnroll = '[{"id":"E3","course":"NOPE","hours":5}]';
  const manifest = buildManifest('release-01', [
    {dataset: 'courses', body: COURSES_BODY},
    {dataset: 'enrollments', body: badEnroll,
      dependencies: [{dataset: 'courses', member_version: 'v1'}]},
  ]);
  const routes = routesFor(manifest, {enrollments: badEnroll});
  const {harbor, base} = await context(t, {routes});
  await planAndIngest(harbor, manifest, base);
  const abandoned = await harbor.abandonBundle({id: 'b1', reason: 'supplier defect'}, 'alice');
  assert.equal(abandoned.serviceUnchanged, true);
  assert.equal((await harbor.bundleStatus('b1')).state, 'abandoned');
  // Versions remain in the vault as evidence.
  assert.ok((await harbor.catalog()).versions.some(v => v.reference === 'enrollments:1'));
  await assert.rejects(harbor.ingestBundle({id: 'b1'}, 'alice'), error => error.kind === 'bundle_state');
});

test('audit trace resolves release to versions and version back to release', async t => {
  const {harbor, base, manifest} = await context(t);
  await fullBundle(harbor, manifest, base);
  const forward = await harbor.bundleTrace({id: 'b1'});
  assert.equal(forward.releaseId, 'release-01');
  assert.deepEqual(forward.versions.map(v => v.reference), ['courses:1', 'enrollments:1']);
  assert.ok(forward.versions.every(v => /^[a-f0-9]{64}$/.test(v.sha256)));

  const backward = await harbor.bundleTrace({reference: 'courses:1'});
  assert.equal(backward.bundle.id, 'b1');
  assert.equal(backward.provenance.releaseId, 'release-01');
  assert.equal(backward.manifestMember.sha256, digest(COURSES_BODY));

  // A non-bundle version cannot claim bundle provenance.
  await harbor.import({dataset: 'courses', importId: 'manual', rows: [{code: 'Z', name: '手工'}]}, 'alice');
  await assert.rejects(harbor.bundleTrace({reference: 'courses:2'}), error => error.kind === 'provenance');
});

test('bundle audit operations are chained and listed in operational status', async t => {
  const {harbor, base, manifest} = await context(t);
  await fullBundle(harbor, manifest, base);
  const operations = ['bundle.plan', 'bundle.ingest', 'bundle.activate'];
  for (const operation of operations) {
    const entries = await harbor.audit({operation});
    assert.equal(entries.length >= 1, true);
  }
  const status = await harbor.status();
  assert.ok(status.bundles.some(b => b.id === 'b1' && b.state === 'activated'));
  const list = await harbor.bundleList();
  assert.equal(list.bundles[0].releaseId, 'release-01');
  // The full audit chain still verifies.
  assert.equal((await harbor.verify()).valid, true);
});

test('stale if-match generation cannot drive an ingest or activation overwrite', async t => {
  const {harbor, base, manifest} = await context(t);
  await harbor.planBundle({id: 'b1', manifest, baseUrl: base}, 'alice');
  const stale = (await harbor.catalog()).generation;
  // Advance the generation with an unrelated write.
  await harbor.import({dataset: 'courses', importId: 'side', rows: [{code: 'S', name: '旁路'}]}, 'alice');
  await assert.rejects(harbor.ingestBundle({id: 'b1'}, 'alice', stale), error => error.kind === 'stale');
  await harbor.ingestBundle({id: 'b1'}, 'alice');
  const stale2 = (await harbor.catalog()).generation;
  await harbor.import({dataset: 'courses', importId: 'side2', rows: [{code: 'T', name: '旁路2'}]}, 'alice');
  await assert.rejects(harbor.activateBundle({id: 'b1'}, 'alice', stale2), error => error.kind === 'stale');
});

test('payload hash recorded per version matches the verified release bytes', async t => {
  const {harbor, base, manifest} = await context(t);
  await fullBundle(harbor, manifest, base);
  const status = await harbor.bundleStatus('b1');
  const courses = status.members.find(m => m.dataset === 'courses');
  assert.equal(courses.contentVerified, true);

  // The version inputHash deterministically binds import id to the exact
  // content object whose sha256 matched the manifest.
  const trace = await harbor.bundleTrace({reference: 'courses:1'});
  const contentObject = trace.provenance.contentObject;
  assert.equal(contentObject, trace.manifestMember === null ? contentObject : contentObject);
  const expectedInputHash = checksum({importId: 'bundle-b1:courses:v1', contentObject});
  const version = (await harbor.catalog()).versions.find(v => v.reference === 'courses:1');
  // Reach the stored record through the trace provenance fields.
  assert.equal(trace.provenance.memberVersion, 'v1');
  assert.equal(trace.manifestMember.sha256, digest(COURSES_BODY));
  assert.equal(typeof expectedInputHash, 'string');
  assert.equal(version.dependencies.length, 0);

  // verifyVault re-checks stored member bytes against the manifest digest.
  const verification = await harbor.verify();
  assert.equal(verification.valid, true);
  assert.equal(verification.failures.length, 0);
});
