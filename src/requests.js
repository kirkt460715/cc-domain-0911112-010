import {fields, key, list, distinct, label, select, instant, demand, found, checksum, encode} from './primitives.js';
import {assertGrant, requireBudget} from './policy.js';
import {requireSteward} from './registry.js';
import {buildDisclosure} from './disclosure.js';

export async function proposeRequest(vault, index, input, actor, at) {
  fields(input, ['id', 'grant', 'reference', 'recipient', 'purpose', 'columns', 'filters', 'format', 'expiresAt'],
    ['id', 'grant', 'reference', 'recipient', 'purpose', 'columns', 'expiresAt']);
  const id = key(input.id);
  const fingerprint = checksum(input);
  const existing = index.requests[id];
  if (existing) {
    demand(existing.inputHash === fingerprint && existing.requestedBy === actor, 'request_conflict', 'Request id already has different content');
    return {noChange: true, result: {request: existing, replay: true}};
  }
  const grant = found(index.grants, key(input.grant), 'Grant');
  const recipient = found(index.organizations, key(input.recipient), 'Recipient');
  requireSteward(index, recipient.id, actor);
  const columns = distinct(list(input.columns, 'columns', 200).map(value => key(value)), 'columns');
  const request = {
    id,
    grant: grant.id,
    reference: input.reference,
    recipient: recipient.id,
    purpose: key(input.purpose),
    columns,
    filters: input.filters ?? [],
    format: select(input.format ?? 'jsonl', ['jsonl', 'json', 'csv'], 'format'),
    expiresAt: instant(input.expiresAt, 'expiresAt'),
    requestedBy: key(actor),
    requestedAt: at,
    inputHash: fingerprint,
    status: 'pending',
    approvals: [],
    policyHash: grant.policyHash,
  };
  demand(request.expiresAt > at && request.expiresAt <= grant.expiresAt, 'request_expiry', 'Request expiry must fit the grant');
  const version = assertGrant(index, grant, request, at);
  const rows = await vault.getRows(version.object);
  const secret = await vault.secret();
  const disclosure = buildDisclosure(rows, version, grant, request, secret);
  demand(disclosure.rows.length > 0, 'empty_release', 'No rows survive disclosure rules');
  requireBudget(index, grant.id, disclosure.rows.length);
  Object.assign(request, {
    outputRows: disclosure.rows.length,
    outputHash: disclosure.fingerprint,
    disclosure: disclosure.report,
    filters: disclosure.filters,
    versionObject: version.object,
    schemaHash: version.schemaHash,
  });
  index.requests[id] = request;
  return {result: {request, replay: false}, audit: {request: id, reservedRows: request.outputRows, grant: grant.id}};
}
export function decideRequest(index, input, actor, at) {
  fields(input, ['id', 'decision', 'reason'], ['id', 'decision', 'reason']);
  const request = found(index.requests, key(input.id), 'Request');
  const grant = found(index.grants, request.grant, 'Grant');
  requireSteward(index, grant.owner, actor);
  demand(actor !== request.requestedBy, 'separation', 'Requester cannot approve their own request');
  demand(request.status === 'pending', 'request_state', 'Request is not pending');
  demand(at < request.expiresAt, 'request_expired', 'Request has expired');
  assertGrant(index, grant, request, at);
  const decision = select(input.decision, ['approve', 'reject'], 'decision');
  const reason = label(input.reason, 'reason', 1000);
  if (decision === 'reject') {
    request.status = 'rejected';
    request.rejection = {actor, reason, at};
  } else {
    demand(!request.approvals.some(approval => approval.actor === actor), 'approval_duplicate', 'Steward has already approved');
    request.approvals.push({actor, reason, at, policyHash: grant.policyHash, outputHash: request.outputHash});
    if (request.approvals.length >= grant.approvalCount) {
      request.status = 'approved';
    }
  }
  return {result: {request}, audit: {request: request.id, decision, status: request.status}};
}
export function cancelRequest(index, input, actor) {
  fields(input, ['id', 'reason'], ['id', 'reason']);
  const request = found(index.requests, key(input.id), 'Request');
  demand(actor === request.requestedBy || index.organizations[index.grants[request.grant].owner].stewards.includes(actor),
    'cancel_actor', 'Only requester or owner steward can cancel', {}, 403);
  demand(['pending', 'approved'].includes(request.status), 'request_state', 'Request can no longer be cancelled');
  request.status = 'cancelled';
  request.cancellation = {actor, reason: label(input.reason, 'reason', 1000)};
  return {result: {request}, audit: {request: request.id, releasedReservation: request.outputRows}};
}
export function expireRequests(index, at) {
  const expired = [];
  for (const request of Object.values(index.requests)) {
    if (['pending', 'approved'].includes(request.status) && request.expiresAt <= at) {
      request.status = 'expired';
      expired.push(request.id);
    }
  }
  return {noChange: expired.length === 0, result: {expired}, audit: {expired}};
}
export function requestSummary(index, id) {
  const request = found(index.requests, key(id), 'Request');
  const grant = index.grants[request.grant];
  return {
    id: request.id,
    status: request.status,
    recipient: request.recipient,
    reference: request.reference,
    purpose: request.purpose,
    outputRows: request.outputRows,
    approvalCount: request.approvals.length,
    requiredApprovals: grant.approvalCount,
    expiresAt: request.expiresAt,
    outputHash: request.outputHash,
    policyHash: request.policyHash,
    release: request.release ?? null,
  };
}
