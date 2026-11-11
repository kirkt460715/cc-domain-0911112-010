import {fields, key, found, demand, encode, checksum, list, count} from './primitives.js';
import {requireSteward} from './registry.js';
import {remainingBudget} from './policy.js';
import {referencedObjects} from './integrity.js';

export function ownerReport(index, owner, actor) {
  requireSteward(index, owner, actor);
  const datasets = Object.values(index.datasets).filter(dataset => dataset.owner === owner);
  const selected = new Set(datasets.map(dataset => dataset.id));
  const versions = Object.values(index.versions).filter(version => selected.has(version.dataset));
  const grants = Object.values(index.grants).filter(grant => grant.owner === owner);
  const grantIds = new Set(grants.map(grant => grant.id));
  const requests = Object.values(index.requests).filter(request => grantIds.has(request.grant));
  const releases = Object.values(index.releases).filter(release => grantIds.has(release.grant));
  const classifications = {};
  for (const dataset of datasets) {
    for (const column of dataset.schema.columns) {
      classifications[column.classification] = (classifications[column.classification] ?? 0) + 1;
    }
  }
  return {
    owner,
    generation: index.generation,
    datasets: datasets.map(dataset => ({id: dataset.id, current: dataset.current, schemaRevision: dataset.schemaRevision})),
    versionCount: versions.length,
    storedRows: versions.reduce((sum, version) => sum + version.rows, 0),
    rejectedRows: versions.reduce((sum, version) => sum + version.report.rejected, 0),
    classifications,
    grants: grants.map(grant => ({id: grant.id, recipient: grant.recipient, status: grant.status, budget: remainingBudget(index, grant.id)})),
    waitingRequests: requests.filter(request => request.status === 'pending').map(request => ({
      id: request.id, approvals: request.approvals.length, required: index.grants[request.grant].approvalCount,
      requester: request.requestedBy, expiresAt: request.expiresAt,
    })),
    releasedRows: releases.reduce((sum, release) => sum + release.rows, 0),
    withdrawnReleases: releases.filter(release => release.status === 'withdrawn').length,
  };
}
export function recipientReport(index, recipient, actor) {
  requireSteward(index, recipient, actor);
  const grants = Object.values(index.grants).filter(grant => grant.recipient === recipient);
  const requests = Object.values(index.requests).filter(request => request.recipient === recipient);
  const releases = Object.values(index.releases).filter(release => release.recipient === recipient);
  return {
    recipient,
    grants: grants.map(grant => ({id: grant.id, dataset: grant.dataset, purposes: grant.purposes,
      columns: grant.columns, status: grant.status, expiresAt: grant.expiresAt})),
    requests: requests.map(request => ({id: request.id, reference: request.reference, status: request.status,
      outputRows: request.outputRows, purpose: request.purpose})),
    releases: releases.map(release => ({id: release.id, reference: release.reference, status: release.status,
      rows: release.rows, expiresAt: release.expiresAt})),
  };
}
export function auditExport(index, input, actor) {
  fields(input, ['owner', 'fromGeneration', 'untilGeneration'], ['owner']);
  const owner = key(input.owner);
  requireSteward(index, owner, actor);
  const from = count(input.fromGeneration ?? 0, 'fromGeneration', 0, index.generation);
  const until = count(input.untilGeneration ?? index.generation, 'untilGeneration', from, index.generation);
  const actors = new Set(index.organizations[owner].stewards);
  const entries = index.audits.filter(entry => entry.generation > from && entry.generation <= until && actors.has(entry.actor));
  const body = {owner, fromGeneration: from, untilGeneration: until, entries};
  return {...body, checksum: checksum(body), completeGlobalChain: false};
}
export function storageReport(index) {
  const references = referencedObjects(index);
  const raw = new Set();
  const tables = new Set();
  const rejected = new Set();
  for (const version of Object.values(index.versions)) {
    raw.add(version.rawObject);
    tables.add(version.object);
    rejected.add(version.rejectedObject);
  }
  const shared = [...references.entries()].filter(([, uses]) => uses.length > 1)
    .map(([hash, uses]) => ({hash, referenceCount: uses.length, uses}));
  return {
    uniqueObjects: references.size,
    uniqueRawTables: raw.size,
    uniqueNormalizedTables: tables.size,
    uniqueRejectionSets: rejected.size,
    sharedObjects: shared,
    logicalVersionBytes: Object.values(index.versions).reduce((sum, version) => sum + version.bytes, 0),
  };
}
export function approvalWorklist(index, actor, at) {
  key(actor);
  return Object.values(index.requests).filter(request => {
    const grant = index.grants[request.grant];
    const owner = index.organizations[grant.owner];
    return request.status === 'pending' && request.expiresAt > at && grant.status === 'active' &&
      owner.enabled && owner.stewards.includes(actor) && actor !== request.requestedBy &&
      !request.approvals.some(approval => approval.actor === actor);
  }).map(request => ({id: request.id, reference: request.reference, recipient: request.recipient, purpose: request.purpose,
    rows: request.outputRows, columns: request.columns, suppressed: request.disclosure.suppressedRows,
    approvals: request.approvals.length, required: index.grants[request.grant].approvalCount,
    expiresAt: request.expiresAt, outputHash: request.outputHash}))
    .sort((a, b) => a.expiresAt.localeCompare(b.expiresAt) || a.id.localeCompare(b.id));
}
