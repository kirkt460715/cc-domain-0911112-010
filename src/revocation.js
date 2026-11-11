import {fields, key, label, found, demand} from './primitives.js';
import {requireSteward} from './registry.js';

export function dependencyClosure(index, references) {
  const affected = new Set(references);
  let advanced = true;
  while (advanced) {
    advanced = false;
    for (const version of Object.values(index.versions)) {
      if (!affected.has(version.reference) && version.dependencies.some(reference => affected.has(reference))) {
        affected.add(version.reference);
        advanced = true;
      }
    }
  }
  return [...affected].sort();
}
export function previewRetirement(index, reference) {
  found(index.versions, reference, 'Version');
  const versions = dependencyClosure(index, [reference]);
  const selected = new Set(versions);
  const requests = Object.values(index.requests).filter(request => selected.has(request.reference) &&
    ['pending', 'approved'].includes(request.status)).map(request => request.id);
  const releases = Object.values(index.releases).filter(release => selected.has(release.reference) &&
    release.status === 'available').map(release => release.id);
  const pointers = Object.values(index.datasets).filter(dataset => selected.has(dataset.current)).map(dataset => dataset.id);
  return {versions, requests, releases, pointers};
}
export function retireVersion(index, input, actor, at) {
  fields(input, ['reference', 'reason', 'cascade'], ['reference', 'reason']);
  const version = found(index.versions, input.reference, 'Version');
  const dataset = index.datasets[version.dataset];
  requireSteward(index, dataset.owner, actor);
  const impact = previewRetirement(index, version.reference);
  demand(input.cascade === true || impact.versions.length === 1, 'dependent_versions',
    'Retirement affects dependent versions; explicit cascade is required', impact, 409);
  const reason = label(input.reason, 'reason', 1000);
  const record = {actor, at, reason, origin: version.reference};
  for (const reference of impact.versions) {
    index.versions[reference].status = 'retired';
    index.versions[reference].retirement = record;
  }
  for (const id of impact.requests) {
    index.requests[id].status = 'invalidated';
    index.requests[id].invalidation = record;
  }
  for (const id of impact.releases) {
    index.releases[id].status = 'withdrawn';
    index.releases[id].withdrawal = record;
  }
  for (const id of impact.pointers) {
    index.datasets[id].current = null;
  }
  return {result: {impact}, audit: {reference: version.reference, reason, impact}};
}
export function revokeGrant(index, input, actor, at) {
  fields(input, ['id', 'reason'], ['id', 'reason']);
  const grant = found(index.grants, key(input.id), 'Grant');
  requireSteward(index, grant.owner, actor);
  if (grant.status === 'revoked') {
    return {noChange: true, result: {id: grant.id, revoked: true}};
  }
  const reason = label(input.reason, 'reason', 1000);
  const withdrawal = {actor, at, reason, origin: grant.id};
  grant.status = 'revoked';
  grant.revocation = withdrawal;
  const requests = [];
  const releases = [];
  for (const request of Object.values(index.requests)) {
    if (request.grant === grant.id && ['pending', 'approved'].includes(request.status)) {
      request.status = 'invalidated';
      request.invalidation = withdrawal;
      requests.push(request.id);
    }
  }
  for (const release of Object.values(index.releases)) {
    if (release.grant === grant.id && release.status === 'available') {
      release.status = 'withdrawn';
      release.withdrawal = withdrawal;
      releases.push(release.id);
    }
  }
  return {result: {id: grant.id, revoked: true, requests, releases},
    audit: {grant: grant.id, reason, requests, releases, budgetRefunded: false}};
}
export function suspendOrganization(index, input, actor, at) {
  fields(input, ['id', 'reason'], ['id', 'reason']);
  const organization = found(index.organizations, key(input.id), 'Organization');
  requireSteward(index, organization.id, actor);
  const reason = label(input.reason, 'reason', 1000);
  const grants = Object.values(index.grants).filter(grant =>
    grant.status === 'active' && (grant.owner === organization.id || grant.recipient === organization.id));
  const affected = [];
  for (const grant of grants) {
    grant.status = 'revoked';
    grant.revocation = {actor, at, reason, origin: organization.id};
    affected.push(grant.id);
  }
  for (const request of Object.values(index.requests)) {
    if (affected.includes(request.grant) && ['pending', 'approved'].includes(request.status)) {
      request.status = 'invalidated';
    }
  }
  for (const release of Object.values(index.releases)) {
    if (affected.includes(release.grant) && release.status === 'available') {
      release.status = 'withdrawn';
      release.withdrawal = {actor, at, reason, origin: organization.id};
    }
  }
  organization.enabled = false;
  return {result: {organization: organization.id, grants: affected}, audit: {organization: organization.id, reason}};
}
