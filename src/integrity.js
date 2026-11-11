import {checksum, encode, demand, decode} from './primitives.js';
import {remainingBudget} from './policy.js';
import {bundleObjects, OPEN_BUNDLE_STATES} from './bundles.js';

export function referencedObjects(index) {
  const references = new Map();
  function add(hash, use) {
    if (!references.has(hash)) {
      references.set(hash, []);
    }
    references.get(hash).push(use);
  }
  for (const version of Object.values(index.versions)) {
    add(version.object, `${version.reference}:table`);
    add(version.rawObject, `${version.reference}:raw`);
    add(version.rejectedObject, `${version.reference}:rejected`);
  }
  for (const release of Object.values(index.releases)) {
    add(release.artifact, `${release.id}:artifact`);
    add(release.manifest, `${release.id}:manifest`);
  }
  for (const [hash, use] of bundleObjects(index)) {
    add(hash, use);
  }
  return references;
}
export function checkIndex(index) {
  const failures = [];
  let previous = '0'.repeat(64);
  let sequence = 1;
  for (const entry of index.audits) {
    const {checksum: hash, ...body} = entry;
    if (checksum(body) !== hash || entry.previous !== previous || entry.generation !== sequence) {
      failures.push({code: 'audit_chain', generation: entry.generation});
    }
    previous = hash;
    sequence += 1;
  }
  if (index.audits.length !== index.generation) {
    failures.push({code: 'audit_count'});
  }
  for (const dataset of Object.values(index.datasets)) {
    if (!index.organizations[dataset.owner]) {
      failures.push({code: 'dataset_owner', dataset: dataset.id});
    }
    if (checksum(dataset.schema) !== dataset.schemaHash) {
      failures.push({code: 'schema_hash', dataset: dataset.id});
    }
    if (dataset.current && index.versions[dataset.current]?.status !== 'active') {
      failures.push({code: 'current_pointer', dataset: dataset.id});
    }
  }
  for (const version of Object.values(index.versions)) {
    if (checksum(version.schema) !== version.schemaHash) {
      failures.push({code: 'version_schema', reference: version.reference});
    }
    if (version.rows !== version.report.accepted || version.report.accepted + version.report.rejected !== version.report.submitted) {
      failures.push({code: 'version_counts', reference: version.reference});
    }
    for (const dependency of version.dependencies) {
      if (!index.versions[dependency]) {
        failures.push({code: 'dependency_missing', reference: version.reference, dependency});
      }
      if (version.status === 'active' && index.versions[dependency]?.status !== 'active') {
        failures.push({code: 'dependency_inactive', reference: version.reference, dependency});
      }
    }
  }
  for (const grant of Object.values(index.grants)) {
    const releases = Object.values(index.releases).filter(release => release.grant === grant.id);
    const spent = releases.reduce((sum, release) => sum + release.rows, 0);
    if (spent !== grant.spentRows || releases.length !== grant.spentReleases) {
      failures.push({code: 'budget_ledger', grant: grant.id});
    }
    const budget = remainingBudget(index, grant.id);
    if (budget.availableRows < 0 || budget.availableReleases < 0) {
      failures.push({code: 'budget_overdrawn', grant: grant.id});
    }
  }
  for (const request of Object.values(index.requests)) {
    if (!index.grants[request.grant] || !index.versions[request.reference]) {
      failures.push({code: 'request_reference', request: request.id});
    }
    if (request.status === 'released' && index.releases[request.release]?.request !== request.id) {
      failures.push({code: 'request_release', request: request.id});
    }
    if (new Set(request.approvals.map(item => item.actor)).size !== request.approvals.length) {
      failures.push({code: 'approval_duplicate', request: request.id});
    }
  }
  for (const bundle of Object.values(index.bundles ?? {})) {
    if (!OPEN_BUNDLE_STATES.includes(bundle.state) && !['activated', 'abandoned'].includes(bundle.state)) {
      failures.push({code: 'bundle_state', bundle: bundle.id});
    }
    const memberDatasets = new Set();
    for (const member of bundle.members) {
      memberDatasets.add(member.dataset);
      if (!index.datasets[member.dataset]) {
        failures.push({code: 'bundle_dataset', bundle: bundle.id, dataset: member.dataset});
      }
      if (member.reference) {
        const version = index.versions[member.reference];
        if (!version) {
          failures.push({code: 'bundle_member_version', bundle: bundle.id, dataset: member.dataset});
        } else if (version.provenance?.bundle !== bundle.id) {
          failures.push({code: 'bundle_provenance', bundle: bundle.id, reference: member.reference});
        }
      }
      for (const dependency of member.dependencies) {
        if (!memberDatasets.has(dependency) && !bundle.members.some(item => item.dataset === dependency)) {
          failures.push({code: 'bundle_dependency', bundle: bundle.id, dataset: member.dataset, dependency});
        }
      }
    }
    if (bundle.state === 'activated') {
      for (const member of bundle.members) {
        const version = index.versions[member.reference];
        const dataset = index.datasets[member.dataset];
        if (!version || version.status !== 'active' || dataset?.current !== member.reference) {
          failures.push({code: 'bundle_activation', bundle: bundle.id, dataset: member.dataset});
        }
      }
    }
  }
  return {valid: failures.length === 0, generation: index.generation, failures};
}
export async function verifyVault(vault, index) {
  const structural = checkIndex(index);
  const failures = [...structural.failures];
  const references = referencedObjects(index);
  for (const [hash, uses] of references) {
    try {
      await vault.getObject(hash);
    } catch (error) {
      failures.push({code: 'object_unreadable', hash, uses, reason: error.kind ?? error.code});
    }
  }
  for (const version of Object.values(index.versions)) {
    try {
      const rows = await vault.getRows(version.object);
      if (rows.length !== version.rows) {
        failures.push({code: 'row_count', reference: version.reference});
      }
    } catch (error) {
      failures.push({code: 'table_unreadable', reference: version.reference, reason: error.kind ?? error.code});
    }
  }
  for (const release of Object.values(index.releases)) {
    try {
      const manifest = decode(await vault.getObject(release.manifest));
      if (manifest.checksum !== release.artifact || manifest.rows !== release.rows || manifest.request !== release.request) {
        failures.push({code: 'manifest_binding', release: release.id});
      }
    } catch (error) {
      failures.push({code: 'manifest_unreadable', release: release.id, reason: error.kind ?? error.code});
    }
  }
  for (const bundle of Object.values(index.bundles ?? {})) {
    for (const member of bundle.members) {
      if (!member.contentObject) {
        continue;
      }
      try {
        const content = await vault.getObject(member.contentObject);
        if (checksum(content) !== member.sha256 || Buffer.byteLength(content) !== member.bytes) {
          failures.push({code: 'bundle_member_digest', bundle: bundle.id, dataset: member.dataset});
        }
      } catch (error) {
        failures.push({code: 'bundle_member_unreadable', bundle: bundle.id, dataset: member.dataset,
          reason: error.kind ?? error.code});
      }
    }
  }
  return {valid: failures.length === 0, generation: index.generation, objects: references.size, failures};
}
export function operationalStatus(index, at) {
  const versions = {};
  const requests = {};
  for (const version of Object.values(index.versions)) {
    versions[version.status] = (versions[version.status] ?? 0) + 1;
  }
  for (const request of Object.values(index.requests)) {
    requests[request.status] = (requests[request.status] ?? 0) + 1;
  }
  const expirable = Object.values(index.requests).filter(request =>
    ['pending', 'approved'].includes(request.status) && request.expiresAt <= at).map(request => request.id);
  const budgets = Object.fromEntries(Object.keys(index.grants).map(id => [id, remainingBudget(index, id)]));
  const quarantined = Object.values(index.versions).filter(version => version.status === 'quarantined')
    .map(version => ({reference: version.reference, failures: version.gate.failures}));
  return {generation: index.generation, versions, requests, expirable, budgets, quarantined,
    bundles: (index.bundles ? Object.values(index.bundles) : []).map(bundle => ({
      id: bundle.id, releaseId: bundle.releaseId, state: bundle.state,
      members: bundle.members.map(member => ({dataset: member.dataset, status: member.status, reference: member.reference})),
    })),
    releases: Object.values(index.releases).map(release => ({id: release.id, status: release.status, expired: at >= release.expiresAt}))};
}
