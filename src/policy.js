import {fields, key, label, list, distinct, select, count, instant, demand, found, checksum, encode} from './primitives.js';
import {CLASSIFICATIONS} from './schema.js';
import {requireSteward, usableVersion} from './registry.js';

export function grantSpec(index, input, actor) {
  fields(input, ['id', 'dataset', 'recipient', 'purposes', 'regions', 'columns', 'maximumClassification',
    'rowBudget', 'releaseLimit', 'expiresAt', 'minimumGroup', 'quasiIdentifiers', 'transforms', 'approvalCount'],
    ['id', 'dataset', 'recipient', 'purposes', 'columns', 'rowBudget', 'expiresAt']);
  const dataset = found(index.datasets, key(input.dataset), 'Dataset');
  requireSteward(index, dataset.owner, actor);
  const recipient = found(index.organizations, key(input.recipient), 'Recipient');
  demand(recipient.enabled, 'recipient_disabled', 'Recipient is disabled');
  const purposes = distinct(list(input.purposes, 'purposes', 30).map(value => key(value)), 'purposes');
  demand(purposes.length > 0 && purposes.every(purpose => recipient.purposes.includes(purpose)),
    'purpose', 'Recipient does not support requested purposes');
  const columns = distinct(list(input.columns, 'columns', 200).map(value => key(value)), 'columns');
  demand(columns.length > 0, 'columns', 'Grant requires released columns');
  const maximum = select(input.maximumClassification ?? 'public', CLASSIFICATIONS, 'maximumClassification');
  const transforms = input.transforms ?? {};
  const quasi = distinct(list(input.quasiIdentifiers ?? [], 'quasiIdentifiers', 20).map(value => key(value)), 'quasiIdentifiers');
  for (const column of columns) {
    const definition = dataset.schema.columns.find(item => item.name === column);
    demand(definition, 'grant_column', 'Grant names an unknown column', {column});
    const action = transforms[column] ?? {kind: 'keep'};
    validateTransform(definition, action);
    const permitted = CLASSIFICATIONS.indexOf(definition.classification) <= CLASSIFICATIONS.indexOf(maximum);
    demand(permitted || ['redact', 'tokenize'].includes(action.kind),
      'classification', 'Column exceeds clearance without protective transform', {column});
    demand(definition.classification !== 'restricted' || action.kind === 'redact',
      'restricted', 'Restricted columns may only be redacted', {column});
  }
  for (const column of Object.keys(transforms)) {
    demand(columns.includes(column), 'transform_column', 'Transform names a column outside grant');
  }
  demand(quasi.every(column => columns.includes(column)), 'quasi_column', 'Quasi identifiers must be released columns');
  const minimumGroup = count(input.minimumGroup ?? 1, 'minimumGroup', 1, 100000);
  demand(minimumGroup === 1 || quasi.length > 0, 'quasi_required', 'Group suppression requires quasi identifiers');
  const approvalCount = count(input.approvalCount ?? 1, 'approvalCount', 1, 10);
  const owner = index.organizations[dataset.owner];
  demand(approvalCount < owner.stewards.length + 1, 'approval_count', 'Insufficient stewards for configured quorum');
  const regions = distinct(list(input.regions ?? [recipient.region], 'regions', 30).map(value => key(value)), 'regions');
  demand(regions.includes(recipient.region), 'region', 'Recipient region is outside grant');
  return {
    id: key(input.id),
    dataset: dataset.id,
    owner: dataset.owner,
    recipient: recipient.id,
    purposes,
    regions,
    columns,
    maximumClassification: maximum,
    rowBudget: count(input.rowBudget, 'rowBudget', 1, 100000000),
    releaseLimit: count(input.releaseLimit ?? 100, 'releaseLimit', 1, 1000000),
    expiresAt: instant(input.expiresAt, 'expiresAt'),
    minimumGroup,
    quasiIdentifiers: quasi,
    transforms,
    approvalCount,
    status: 'active',
    spentRows: 0,
    spentReleases: 0,
  };
}
export function validateTransform(column, transform) {
  fields(transform, ['kind', 'width', 'length', 'unit'], ['kind']);
  select(transform.kind, ['keep', 'redact', 'tokenize', 'bucket', 'prefix', 'date_floor'], 'transform');
  if (transform.kind === 'bucket') {
    demand(['integer', 'number'].includes(column.type), 'transform_type', 'Bucket requires numeric column');
    demand(typeof transform.width === 'number' && Number.isFinite(transform.width) && transform.width > 0,
      'bucket_width', 'Bucket width must be positive');
  }
  if (transform.kind === 'prefix') {
    demand(['string', 'enum'].includes(column.type), 'transform_type', 'Prefix requires text column');
    count(transform.length, 'length', 1, column.maxLength);
  }
  if (transform.kind === 'date_floor') {
    demand(['date', 'timestamp'].includes(column.type), 'transform_type', 'Date flooring requires temporal column');
    select(transform.unit, ['month', 'year'], 'unit');
  }
}
export function addGrant(index, input, actor, at) {
  const grant = grantSpec(index, input, actor);
  demand(!index.grants[grant.id], 'grant_exists', 'Grant id already exists');
  demand(grant.expiresAt > at, 'grant_expired', 'Grant expiry must be in the future');
  grant.policyHash = checksum(grant);
  index.grants[grant.id] = grant;
  return {result: {grant}, audit: {grant: grant.id, policyHash: grant.policyHash}};
}
export function assertGrant(index, grant, request, at) {
  demand(grant.status === 'active', 'grant_revoked', 'Grant is not active');
  demand(at < grant.expiresAt, 'grant_expired', 'Grant has expired');
  const recipient = found(index.organizations, grant.recipient, 'Recipient');
  demand(recipient.enabled, 'recipient_disabled', 'Recipient is disabled');
  demand(grant.regions.includes(recipient.region), 'region', 'Recipient region is not permitted');
  demand(request.recipient === grant.recipient, 'recipient', 'Request recipient differs from grant');
  demand(grant.purposes.includes(request.purpose), 'purpose', 'Purpose is outside grant');
  const version = usableVersion(index, request.reference);
  demand(version.dataset === grant.dataset, 'grant_dataset', 'Version is outside grant dataset');
  const columns = request.columns;
  demand(columns.length > 0 && columns.every(column => grant.columns.includes(column)), 'grant_columns', 'Requested columns exceed grant');
  demand(grant.quasiIdentifiers.every(column => columns.includes(column)), 'quasi_missing', 'Request omits required quasi identifier');
  for (const name of columns) {
    const column = version.schema.columns.find(item => item.name === name);
    demand(column, 'version_column', 'Column is absent in pinned version');
    const action = grant.transforms[name] ?? {kind: 'keep'};
    validateTransform(column, action);
    demand(CLASSIFICATIONS.indexOf(column.classification) <= CLASSIFICATIONS.indexOf(grant.maximumClassification) ||
      ['redact', 'tokenize'].includes(action.kind), 'classification', 'Pinned version classification exceeds grant');
    demand(column.classification !== 'restricted' || action.kind === 'redact', 'restricted', 'Restricted values cannot be released');
  }
  return version;
}
export function remainingBudget(index, grantId, exceptRequest = null) {
  const grant = found(index.grants, grantId, 'Grant');
  const reserved = Object.values(index.requests).filter(request => request.grant === grantId &&
    request.id !== exceptRequest && ['pending', 'approved'].includes(request.status));
  const reservedRows = reserved.reduce((sum, request) => sum + request.outputRows, 0);
  return {
    totalRows: grant.rowBudget,
    spentRows: grant.spentRows,
    reservedRows,
    availableRows: grant.rowBudget - grant.spentRows - reservedRows,
    totalReleases: grant.releaseLimit,
    spentReleases: grant.spentReleases,
    reservedReleases: reserved.length,
    availableReleases: grant.releaseLimit - grant.spentReleases - reserved.length,
  };
}
export function requireBudget(index, grantId, rows, exceptRequest = null) {
  const budget = remainingBudget(index, grantId, exceptRequest);
  demand(rows <= budget.availableRows && budget.availableReleases >= 1, 'budget', 'Grant budget is exhausted', budget, 409);
  return budget;
}
