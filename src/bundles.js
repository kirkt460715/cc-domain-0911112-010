import {HarborError, fields, key, label, list, count, found, demand, checksum, decode} from './primitives.js';
import {requireSteward, usableVersion, versionRecord} from './registry.js';
import {normalizeMapping, transformRows, sortRows} from './tabular.js';
import {validateTable, tableProfile, evaluateGate} from './quality.js';

export const OPEN_BUNDLE_STATES = ['planned', 'ingesting', 'verified', 'failed'];
const FETCH_LIMIT_BYTES = 32 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10000;

function memberId(value) {
  return key(value, 'member dataset');
}
function supplierVersion(value) {
  return label(value, 'member_version', 120);
}
function digest(value) {
  demand(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'digest',
    'Member sha256 must be 64 lowercase hex characters');
  return value;
}
function memberUrl(value) {
  const url = label(value, 'url', 2000);
  demand(/^(?:https?:\/\/|\/)[^\s]+$/.test(url), 'manifest_url',
    'Member url must be an absolute http(s) url or an absolute path resolved against baseUrl');
  return url;
}

// ---------------------------------------------------------------------------
// Manifest parsing: shape, intra-release dependency edges, byte-digest shape
// and dependency-cycle detection (Kahn topological sort).
// ---------------------------------------------------------------------------
export function parseManifest(document) {
  fields(document, ['release_id', 'members'], ['release_id', 'members']);
  const releaseId = label(document.release_id, 'release_id', 120);
  const entries = list(document.members, 'members', 200);
  demand(entries.length > 0, 'manifest_empty', 'Release manifest declares no members');
  const members = [];
  const seen = new Set();
  for (const entry of entries) {
    fields(entry, ['dataset', 'member_version', 'schema_revision', 'url', 'sha256', 'bytes', 'dependencies'],
      ['dataset', 'member_version', 'schema_revision', 'url', 'sha256', 'bytes']);
    const dataset = memberId(entry.dataset);
    demand(!seen.has(dataset), 'manifest_duplicate', 'Manifest declares a dataset more than once', {dataset});
    seen.add(dataset);
    count(entry.schema_revision, 'schema_revision', 1);
    count(entry.bytes, 'bytes', 1, FETCH_LIMIT_BYTES);
    const dependencies = list(entry.dependencies ?? [], 'dependencies', 200).map(dependency => {
      fields(dependency, ['dataset', 'member_version'], ['dataset', 'member_version']);
      return {dataset: memberId(dependency.dataset), member_version: supplierVersion(dependency.member_version)};
    });
    members.push({
      dataset,
      memberVersion: supplierVersion(entry.member_version),
      schemaRevision: entry.schema_revision,
      url: memberUrl(entry.url),
      sha256: digest(entry.sha256),
      bytes: entry.bytes,
      dependencies,
    });
  }
  const declared = new Map(members.map(member => [member.dataset, member]));
  for (const member of members) {
    const targets = new Set();
    for (const dependency of member.dependencies) {
      const target = declared.get(dependency.dataset);
      demand(target, 'manifest_missing_member', 'Manifest dependency references an undeclared member',
        {dataset: member.dataset, dependency: dependency.dataset});
      demand(target.memberVersion === dependency.member_version, 'manifest_dependency_version',
        'Manifest dependency pins a member_version not present in this release',
        {dataset: member.dataset, dependency: dependency.dataset});
      demand(!targets.has(dependency.dataset), 'manifest_duplicate', 'Repeated dependency edge',
        {dataset: member.dataset, dependency: dependency.dataset});
      targets.add(dependency.dataset);
    }
  }
  const indegree = new Map(members.map(member => [member.dataset, 0]));
  for (const member of members) {
    for (const dependency of member.dependencies) {
      indegree.set(member.dataset, indegree.get(member.dataset) + 1);
    }
  }
  const order = [];
  const ready = members.filter(member => indegree.get(member.dataset) === 0).map(member => member.dataset).sort();
  while (ready.length) {
    const current = ready.shift();
    order.push(current);
    for (const member of members) {
      if (member.dependencies.some(dependency => dependency.dataset === current)) {
        const next = indegree.get(member.dataset) - 1;
        indegree.set(member.dataset, next);
        if (next === 0) {
          ready.push(member.dataset);
          ready.sort();
        }
      }
    }
  }
  demand(order.length === members.length, 'manifest_cycle', 'Manifest dependency graph contains a cycle',
    {unresolved: members.map(member => member.dataset).filter(dataset => !order.includes(dataset))});
  return {releaseId, members, order, manifestHash: checksum(document)};
}

// Local registration, steward authority and schema-revision / foreign-key
// agreement are diagnosed as a structured problem list instead of one abort.
function requireLocalDatasets(index, parsed, actor) {
  const problems = [];
  for (const member of parsed.members) {
    const dataset = index.datasets[member.dataset];
    if (!dataset) {
      problems.push({code: 'dataset_unknown', dataset: member.dataset});
      continue;
    }
    if (actor !== undefined) {
      try {
        requireSteward(index, dataset.owner, actor);
      } catch (error) {
        problems.push({code: 'steward', dataset: member.dataset, message: error.message});
      }
    }
    if (dataset.schemaRevision !== member.schemaRevision) {
      problems.push({code: 'schema_revision_mismatch', dataset: member.dataset,
        local: dataset.schemaRevision, manifest: member.schemaRevision});
    }
    const localTargets = new Set(dataset.schema.foreignKeys.map(foreign => foreign.target));
    const manifestTargets = new Set(member.dependencies.map(dependency => dependency.dataset));
    for (const target of localTargets) {
      if (!manifestTargets.has(target)) {
        problems.push({code: 'dependency_undeclared', dataset: member.dataset, dependency: target});
      }
    }
    for (const target of manifestTargets) {
      if (!localTargets.has(target)) {
        problems.push({code: 'dependency_extra', dataset: member.dataset, dependency: target});
      }
    }
  }
  return problems;
}

function planSnapshot(index, parsed) {
  return {
    schemaHash: Object.fromEntries(parsed.members.map(member => [member.dataset, index.datasets[member.dataset]?.schemaHash ?? null])),
    current: Object.fromEntries(parsed.members.map(member => [member.dataset, index.datasets[member.dataset]?.current ?? null])),
  };
}

// ---------------------------------------------------------------------------
// Planning and preview
// ---------------------------------------------------------------------------
export function planBundle(index, input, actor, at) {
  fields(input, ['id', 'manifest', 'baseUrl', 'headers', 'mapping', 'importIdPrefix'], ['id', 'manifest']);
  const id = key(input.id);
  demand(!index.bundles[id], 'bundle_exists', 'Bundle id is already occupied');
  const parsed = parseManifest(input.manifest);
  const problems = requireLocalDatasets(index, parsed, actor);
  // Planning is an authoritative write: structural mismatches are returned for
  // diagnosis, but missing steward permission aborts before anything is stored.
  const authority = problems.find(problem => problem.code === 'steward');
  if (authority) {
    demand(false, 'steward', authority.message, {dataset: authority.dataset}, 403);
  }
  const mapping = input.mapping ?? {};
  fields(mapping, parsed.members.map(member => member.dataset), []);
  const baseUrl = input.baseUrl === undefined ? '' : label(input.baseUrl, 'baseUrl', 2000);
  demand(baseUrl === '' || /^https?:\/\/[^\s]+$/.test(baseUrl), 'base_url', 'baseUrl must be an absolute http(s) url');
  for (const member of parsed.members) {
    demand(!member.url.startsWith('/') || baseUrl, 'base_url',
      'Relative member urls require a baseUrl', {dataset: member.dataset});
  }
  const headers = {};
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    demand(/^[a-zA-Z][a-zA-Z0-9-]{0,63}$/.test(name), 'header_name', 'Unsupported header name', {name});
    demand(typeof value === 'string' && value.length <= 4096, 'header_value', 'Header value must be bounded text', {name});
    headers[name.toLowerCase()] = value;
  }
  const prefix = input.importIdPrefix === undefined ? `bundle-${id}` : label(input.importIdPrefix, 'importIdPrefix', 60);
  const bundle = {
    id,
    releaseId: parsed.releaseId,
    manifestHash: parsed.manifestHash,
    state: 'planned',
    order: parsed.order,
    members: parsed.members.map(member => ({
      dataset: member.dataset,
      memberVersion: member.memberVersion,
      schemaRevision: member.schemaRevision,
      url: member.url,
      sha256: member.sha256,
      bytes: member.bytes,
      dependencies: member.dependencies.map(dependency => dependency.dataset),
      status: 'pending',
      attempts: 0,
      contentObject: null,
      reference: null,
    })),
    mapping,
    transport: {baseUrl, headers},
    importIdPrefix: prefix,
    plan: planSnapshot(index, parsed),
    planGeneration: index.generation,
    createdBy: actor,
    createdAt: at,
    updatedAt: at,
    activatedAt: null,
    failures: [],
  };
  index.bundles[id] = bundle;
  return {
    result: {bundle: bundleView(bundle), problems, ingestOrder: parsed.order, ready: problems.length === 0},
    audit: {bundle: id, release: parsed.releaseId, members: parsed.members.length,
      manifestHash: parsed.manifestHash, problems: problems.length},
  };
}

export function previewBundle(index, input, actor) {
  fields(input, ['manifest', 'baseUrl'], ['manifest']);
  const parsed = parseManifest(input.manifest);
  const problems = requireLocalDatasets(index, parsed, actor);
  return {
    generation: index.generation,
    releaseId: parsed.releaseId,
    manifestHash: parsed.manifestHash,
    ingestOrder: parsed.order,
    members: parsed.members.map(member => ({
      dataset: member.dataset,
      memberVersion: member.memberVersion,
      schemaRevision: member.schemaRevision,
      bytes: member.bytes,
      dependencies: member.dependencies.map(dependency => dependency.dataset),
    })),
    problems,
    ready: problems.length === 0,
  };
}

export function bundleView(bundle) {
  return {
    id: bundle.id,
    releaseId: bundle.releaseId,
    state: bundle.state,
    manifestHash: bundle.manifestHash,
    planGeneration: bundle.planGeneration,
    ingestOrder: bundle.order,
    members: bundle.members.map(member => ({...member})),
    failures: bundle.failures.map(failure => ({...failure})),
    createdBy: bundle.createdBy,
    createdAt: bundle.createdAt,
    updatedAt: bundle.updatedAt,
    activatedAt: bundle.activatedAt,
  };
}

export function bundleSummary(index) {
  return Object.values(index.bundles).map(bundle => ({
    id: bundle.id,
    releaseId: bundle.releaseId,
    state: bundle.state,
    members: bundle.members.map(member => ({dataset: member.dataset, status: member.status, reference: member.reference})),
  }));
}

// ---------------------------------------------------------------------------
// Transport: bounded, timeout-protected GET. Downloaded bytes are untrusted;
// only size and digest are checked here, interpretation happens later.
// ---------------------------------------------------------------------------
export async function fetchMember(member, transport) {
  const target = new URL(member.url, transport.baseUrl || undefined);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(target, {method: 'GET', redirect: 'error', signal: controller.signal, headers: transport.headers});
  } catch (error) {
    throw new HarborError('fetch_unavailable', `Member endpoint is unreachable: ${error.message}`,
      {dataset: member.dataset, cause: error.name}, 502);
  } finally {
    clearTimeout(timer);
  }
  demand(response.ok, 'fetch_status', 'Member endpoint returned an error status',
    {dataset: member.dataset, status: response.status}, 502);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    demand(bytes <= FETCH_LIMIT_BYTES, 'fetch_limit', 'Member payload exceeds the fetch limit',
      {dataset: member.dataset, limit: FETCH_LIMIT_BYTES}, 413);
    chunks.push(Buffer.from(chunk));
  }
  const content = Buffer.concat(chunks);
  demand(content.length === member.bytes, 'member_size', 'Downloaded byte count differs from the manifest',
    {dataset: member.dataset, expected: member.bytes, actual: content.length});
  demand(checksum(content) === member.sha256, 'member_digest', 'Downloaded digest differs from the manifest',
    {dataset: member.dataset, expected: member.sha256, actual: checksum(content)});
  return content;
}

// ---------------------------------------------------------------------------
// Ingestion: members are imported in dependency order, pinning foreign keys to
// concrete versions produced inside this same release, never the live pointer.
// ---------------------------------------------------------------------------
async function prepareBundleMember(vault, index, bundle, member) {
  const dataset = found(index.datasets, member.dataset, 'Dataset');
  demand(dataset.schemaRevision === member.schemaRevision, 'bundle_schema_drift',
    'Local schema revision changed after the bundle was planned; replan required',
    {dataset: member.dataset, local: dataset.schemaRevision, planned: member.schemaRevision}, 409);
  const raw = decode(await vault.getObject(member.contentObject));
  demand(Array.isArray(raw), 'member_shape', 'Member payload must decode to a JSON table', {dataset: member.dataset});
  const rows = list(raw, 'member rows', 100000);
  demand(rows.length > 0, 'empty_import', 'Member contains no rows');
  const targetColumns = dataset.schema.columns.map(column => column.name);
  const mapping = normalizeMapping(bundle.mapping[member.dataset] ?? [], targetColumns);
  const transformed = transformRows(rows, mapping, targetColumns);
  const references = {};
  const dependencies = [];
  for (const dependencyDataset of member.dependencies) {
    const parentMember = bundle.members.find(item => item.dataset === dependencyDataset);
    demand(parentMember && parentMember.reference, 'bundle_dependency_not_ready',
      'Dependency member has no imported version yet', {dataset: member.dataset, dependency: dependencyDataset});
    demand(dataset.schema.foreignKeys.some(foreign => foreign.target === dependencyDataset),
      'bundle_dependency_unknown', 'Manifest dependency has no matching local foreign key',
      {dataset: member.dataset, dependency: dependencyDataset});
    const reference = parentMember.reference;
    // Frozen intra-release reference: validate against the concrete version
    // produced by THIS release, even though the group is not active yet.
    // The live current pointer is never consulted here.
    const parent = versionRecord(index, reference);
    demand(parent.provenance?.bundle === bundle.id &&
      ['validated', 'active'].includes(parent.status), 'bundle_frozen_reference',
      'Dependency must be a validated member of the same release',
      {dataset: member.dataset, dependency: dependencyDataset, reference});
    references[dependencyDataset] = {reference, rows: await vault.getRows(parent.object)};
    dependencies.push(reference);
  }
  const validated = validateTable(transformed, dataset.schema, references, {coerce: false});
  const sorted = sortRows(validated.rows, dataset.schema.primaryKey);
  const profile = tableProfile(sorted, dataset.schema);
  const gate = evaluateGate(validated.report, profile, dataset.gate);
  return {dataset, rows: sorted, raw, rejected: validated.rejected, report: validated.report,
    profile, gate, dependencies: dependencies.sort(), mapping};
}

async function importBundleMember(vault, index, bundle, member, actor, at) {
  const importId = `${bundle.importIdPrefix}:${member.dataset}:${member.memberVersion}`;
  const inputHash = checksum({importId, contentObject: member.contentObject});
  const previous = Object.values(index.versions).find(version =>
    version.dataset === member.dataset && version.importId === importId);
  if (previous) {
    // Same logical member is only reusable when the bytes are identical;
    // the same release pointing at different bytes must be isolated, not merged.
    demand(previous.inputHash === inputHash, 'bundle_byte_conflict',
      'Same release member already exists with different bytes', {dataset: member.dataset, importId}, 409);
    return previous;
  }
  const prepared = await prepareBundleMember(vault, index, bundle, member);
  const dataset = prepared.dataset;
  const rawObject = await vault.putObject(prepared.raw);
  const data = await vault.putObject(prepared.rows);
  const rejects = await vault.putObject(prepared.rejected);
  const number = dataset.nextVersion;
  const reference = `${dataset.id}:${number}`;
  const record = {
    reference,
    dataset: dataset.id,
    version: number,
    importId,
    inputHash,
    schema: structuredClone(dataset.schema),
    schemaHash: dataset.schemaHash,
    schemaRevision: dataset.schemaRevision,
    status: prepared.gate.passed ? 'validated' : 'quarantined',
    object: data.hash,
    rawObject: rawObject.hash,
    rejectedObject: rejects.hash,
    bytes: data.bytes,
    rows: prepared.rows.length,
    report: prepared.report,
    profile: prepared.profile,
    gate: prepared.gate,
    dependencies: prepared.dependencies,
    mapping: prepared.mapping,
    createdBy: actor,
    createdAt: at,
    provenance: {kind: 'bundle', bundle: bundle.id, releaseId: bundle.releaseId,
      memberVersion: member.memberVersion, manifestHash: bundle.manifestHash, contentObject: member.contentObject},
  };
  index.versions[reference] = record;
  dataset.nextVersion += 1;
  return record;
}

function fail(bundle, failure, at) {
  bundle.failures.push(failure);
  bundle.state = 'failed';
  bundle.updatedAt = at;
}

export async function ingestBundle(vault, index, input, actor, at) {
  fields(input, ['id'], ['id']);
  const bundle = found(index.bundles, key(input.id), 'Bundle');
  demand(OPEN_BUNDLE_STATES.includes(bundle.state), 'bundle_state',
    'Bundle cannot ingest from its current state', {state: bundle.state}, 409);
  for (const member of bundle.members) {
    const dataset = index.datasets[member.dataset];
    demand(dataset, 'dataset_unknown', 'Local dataset disappeared; replan required', {dataset: member.dataset});
    requireSteward(index, dataset.owner, actor);
  }
  // Stale plans never overwrite: schema, authority and active-version movement
  // force a fresh plan. Re-checked on every resume, so lapsed grants cannot be
  // reused even though verified bytes can.
  const drift = detectDrift(index, bundle, at);
  if (drift.length) {
    bundle.failures = [{phase: 'plan', code: 'bundle_replan_required',
      message: 'Schema, authorization or active versions changed since planning', drift}];
    bundle.state = 'failed';
    bundle.updatedAt = at;
    return {
      result: {bundle: bundleView(bundle), activated: false, serviceUnchanged: true},
      audit: {bundle: bundle.id, operation: 'ingest', result: 'replan_required', drift: drift.map(item => item.code)},
    };
  }
  bundle.state = 'ingesting';
  bundle.failures = [];
  bundle.updatedAt = at;
  for (const datasetId of bundle.order) {
    const member = bundle.members.find(item => item.dataset === datasetId);
    member.attempts += 1;
    // Pause/resume: imported members and verified bytes are reused.
    if (member.reference) {
      const existing = versionRecord(index, member.reference);
      demand(existing.provenance?.bundle === bundle.id, 'bundle_provenance',
        'Member reference no longer belongs to this bundle', {dataset: datasetId});
      member.status = existing.status;
      continue;
    }
    if (!member.contentObject) {
      try {
        const content = await fetchMember(member, bundle.transport);
        member.contentObject = (await vault.putObject(content.toString('utf8'))).hash;
      } catch (error) {
        member.status = 'failed';
        fail(bundle, {phase: 'fetch', dataset: datasetId, code: error.kind ?? 'fetch_failed',
          message: error.message, context: error.context ?? {}}, at);
        continue;
      }
    } else {
      // Stored bytes are re-verified on resume; a stale digest verdict is never reused.
      try {
        const stored = await vault.getObject(member.contentObject);
        demand(checksum(stored) === member.sha256 && Buffer.byteLength(stored) === member.bytes,
          'member_digest', 'Stored member bytes no longer match the manifest', {dataset: datasetId});
      } catch (error) {
        member.status = 'failed';
        fail(bundle, {phase: 'verify', dataset: datasetId, code: error.kind, message: error.message,
          context: error.context ?? {}}, at);
        continue;
      }
    }
    try {
      const version = await importBundleMember(vault, index, bundle, member, actor, at);
      member.reference = version.reference;
      member.status = version.status;
      if (version.status === 'quarantined') {
        fail(bundle, {phase: 'quality', dataset: datasetId, code: 'member_quarantined',
          message: 'Member failed validation gates; evidence retained for diagnosis',
          report: version.report, gate: version.gate.failures}, at);
      }
    } catch (error) {
      // Diverging bytes for the same logical member is an integrity isolation
      // breach, not a recoverable member defect: abort rather than continue.
      if (error.kind === 'bundle_byte_conflict') {
        throw error;
      }
      member.status = 'failed';
      fail(bundle, {phase: 'import', dataset: datasetId, code: error.kind ?? 'import_failed',
        message: error.message, context: error.context ?? {}}, at);
    }
  }
  if (bundle.failures.length === 0) {
    bundle.state = 'verified';
  }
  bundle.updatedAt = at;
  const failed = bundle.failures.map(failure => ({dataset: failure.dataset, code: failure.code, phase: failure.phase}));
  return {
    result: {bundle: bundleView(bundle), readyToActivate: bundle.state === 'verified',
      activated: false, serviceUnchanged: true},
    audit: {bundle: bundle.id, operation: 'ingest', result: bundle.state,
      versions: bundle.members.map(member => ({dataset: member.dataset, reference: member.reference})),
      failures: failed},
  };
}

// ---------------------------------------------------------------------------
// Drift detection and atomic group activation
// ---------------------------------------------------------------------------
export function detectDrift(index, bundle, at = null) {
  const drift = [];
  // Once the bundle itself performed the switch, the post-activation world is
  // its baseline; only movement after that counts as drift.
  const baseline = bundle.activation ?? bundle.plan;
  for (const member of bundle.members) {
    const dataset = index.datasets[member.dataset];
    if (!dataset) {
      drift.push({code: 'dataset_unknown', dataset: member.dataset});
      continue;
    }
    if (dataset.schemaHash !== baseline.schemaHash[member.dataset]) {
      drift.push({code: 'schema_changed', dataset: member.dataset});
    }
    if (dataset.schemaRevision !== member.schemaRevision) {
      drift.push({code: 'schema_revision_changed', dataset: member.dataset});
    }
    if (dataset.current !== baseline.current[member.dataset]) {
      drift.push({code: 'active_version_changed', dataset: member.dataset,
        baseline: baseline.current[member.dataset], current: dataset.current});
    }
  }
  for (const grant of Object.values(index.grants)) {
    if (!bundle.members.some(member => member.dataset === grant.dataset)) {
      continue;
    }
    if (grant.status !== 'active') {
      drift.push({code: 'grant_revoked', grant: grant.id, dataset: grant.dataset});
    } else if (at !== null && at >= grant.expiresAt) {
      drift.push({code: 'grant_expired', grant: grant.id, dataset: grant.dataset});
    }
  }
  return drift;
}

export function activateBundle(index, input, actor, at) {
  fields(input, ['id'], ['id']);
  const bundle = found(index.bundles, key(input.id), 'Bundle');
  demand(bundle.state === 'verified' || bundle.state === 'activated', 'bundle_state',
    'Only a fully verified bundle can activate', {state: bundle.state}, 409);
  const drift = detectDrift(index, bundle, at);
  demand(drift.length === 0, 'bundle_replan_required',
    'Schema, authorization or active versions changed; replan and re-ingest', {drift}, 409);
  const switches = [];
  for (const datasetId of bundle.order) {
    const member = bundle.members.find(item => item.dataset === datasetId);
    const dataset = found(index.datasets, member.dataset, 'Dataset');
    requireSteward(index, dataset.owner, actor);
    const version = versionRecord(index, member.reference);
    demand(version.status === 'validated' || version.status === 'active', 'member_state',
      'Member version is not eligible for activation', {dataset: member.dataset, status: version.status});
    for (const dependency of version.dependencies) {
      usableVersion(index, dependency);
    }
    if (dataset.current === version.reference && version.status === 'active') {
      member.status = 'active';
      continue;
    }
    version.status = 'active';
    dataset.current = version.reference;
    member.status = 'active';
    switches.push({dataset: dataset.id, current: version.reference});
  }
  const alreadyActive = bundle.state === 'activated';
  bundle.state = 'activated';
  bundle.activatedAt = bundle.activatedAt ?? at;
  bundle.updatedAt = at;
  // Freeze the world produced by this activation as the new drift baseline.
  bundle.activation = {
    schemaHash: Object.fromEntries(bundle.members.map(member => [member.dataset, index.datasets[member.dataset].schemaHash])),
    current: Object.fromEntries(bundle.members.map(member => [member.dataset, index.datasets[member.dataset].current])),
  };
  return {
    noChange: alreadyActive && switches.length === 0,
    result: {bundle: bundleView(bundle), switches, activated: true},
    audit: {bundle: bundle.id, operation: 'activate', switches},
  };
}

export function abandonBundle(index, input, actor, at) {
  fields(input, ['id', 'reason'], ['id', 'reason']);
  const bundle = found(index.bundles, key(input.id), 'Bundle');
  demand(OPEN_BUNDLE_STATES.includes(bundle.state), 'bundle_state',
    'Bundle is already finished and cannot be abandoned', {state: bundle.state}, 409);
  for (const member of bundle.members) {
    const dataset = index.datasets[member.dataset];
    if (dataset) {
      requireSteward(index, dataset.owner, actor);
    }
  }
  bundle.state = 'abandoned';
  bundle.updatedAt = at;
  bundle.abandonment = {actor, reason: label(input.reason, 'reason', 1000), at};
  // Imported versions remain in the vault as immutable diagnostic evidence;
  // current product pointers are never touched by abandonment.
  return {
    result: {bundle: bundleView(bundle), serviceUnchanged: true},
    audit: {bundle: bundle.id, operation: 'abandon', reason: bundle.abandonment.reason},
  };
}

export function bundleStatus(index, id, at) {
  const bundle = found(index.bundles, key(id), 'Bundle');
  const members = bundle.members.map(member => {
    const version = member.reference ? index.versions[member.reference] : null;
    return {
      dataset: member.dataset,
      memberVersion: member.memberVersion,
      status: member.status,
      attempts: member.attempts,
      reference: member.reference,
      contentVerified: member.contentObject !== null,
      rows: version?.rows ?? null,
      quality: version ? {accepted: version.report.accepted, rejected: version.report.rejected,
        issues: version.report.issues, gatePassed: version.gate.passed} : null,
    };
  });
  return {
    id: bundle.id,
    releaseId: bundle.releaseId,
    state: bundle.state,
    manifestHash: bundle.manifestHash,
    planGeneration: bundle.planGeneration,
    generation: index.generation,
    drift: detectDrift(index, bundle, at),
    ingestOrder: bundle.order,
    members,
    failures: bundle.failures,
    createdAt: bundle.createdAt,
    updatedAt: bundle.updatedAt,
    activatedAt: bundle.activatedAt,
  };
}

// Audit trace: release -> every produced version, and stored version -> release.
export function bundleTrace(index, input) {
  fields(input, ['id', 'reference'], []);
  if (input.id !== undefined) {
    const bundle = found(index.bundles, key(input.id), 'Bundle');
    return {
      direction: 'bundle',
      bundle: bundle.id,
      releaseId: bundle.releaseId,
      manifestHash: bundle.manifestHash,
      state: bundle.state,
      versions: bundle.members.map(member => ({
        dataset: member.dataset,
        memberVersion: member.memberVersion,
        reference: member.reference,
        sha256: member.sha256,
        contentObject: member.contentObject,
        status: member.status,
      })),
    };
  }
  if (input.reference !== undefined) {
    const version = found(index.versions, input.reference, 'Version');
    demand(version.provenance?.kind === 'bundle', 'provenance',
      'Version was not produced by a release bundle', {reference: input.reference});
    const bundle = found(index.bundles, version.provenance.bundle, 'Bundle');
    const member = bundle.members.find(item => item.dataset === version.dataset);
    return {
      direction: 'version',
      reference: version.reference,
      provenance: version.provenance,
      bundle: {id: bundle.id, releaseId: bundle.releaseId, state: bundle.state, manifestHash: bundle.manifestHash},
      manifestMember: member ? {sha256: member.sha256, bytes: member.bytes, memberVersion: member.memberVersion,
        dependencies: member.dependencies} : null,
    };
  }
  demand(false, 'required', 'Supply bundle id or version reference');
}

export function bundleObjects(index) {
  const objects = new Map();
  for (const bundle of Object.values(index.bundles)) {
    for (const member of bundle.members) {
      if (member.contentObject) {
        objects.set(member.contentObject, `${bundle.id}:${member.dataset}:content`);
      }
    }
  }
  return objects;
}
