import {fields, key, label, list, distinct, found, demand, checksum, versionKey, count, encode} from './primitives.js';
import {schemaSpec, compareSchemas} from './schema.js';
import {gateSpec} from './quality.js';

export function organizationSpec(input) {
  fields(input, ['id', 'name', 'region', 'purposes', 'stewards'], ['id', 'name', 'region', 'purposes', 'stewards']);
  const purposes = distinct(list(input.purposes, 'purposes', 30).map(value => key(value)), 'purposes');
  const stewards = distinct(list(input.stewards, 'stewards', 20).map(value => key(value)), 'stewards');
  demand(purposes.length > 0 && stewards.length > 0, 'organization', 'Purposes and stewards cannot be empty');
  return {id: key(input.id), name: label(input.name), region: key(input.region), purposes, stewards, enabled: true};
}
export function addOrganization(index, input) {
  const organization = organizationSpec(input);
  demand(!index.organizations[organization.id], 'organization_exists', 'Organization already exists');
  index.organizations[organization.id] = organization;
  return {result: {organization}, audit: {organization: organization.id}};
}
export function datasetSpec(index, input) {
  fields(input, ['id', 'name', 'owner', 'schema', 'gate', 'description'], ['id', 'name', 'owner', 'schema']);
  const owner = found(index.organizations, key(input.owner), 'Organization');
  demand(owner.enabled, 'organization_disabled', 'Owner is disabled');
  const schema = schemaSpec(input.schema);
  const gate = gateSpec(input.gate);
  for (const column of [...Object.keys(gate.maxNullFractions), ...Object.keys(gate.minimumDistinct)]) {
    demand(schema.columns.some(item => item.name === column), 'gate_column', 'Gate references unknown column');
  }
  for (const foreign of schema.foreignKeys) {
    const target = found(index.datasets, foreign.target, 'Reference dataset');
    demand(target.owner === owner.id, 'reference_owner', 'Foreign keys must remain within the owner organization');
    demand(encode(foreign.targetColumns) === encode(target.schema.primaryKey),
      'reference_key', 'Foreign key must target the complete primary key');
    for (let position = 0; position < foreign.columns.length; position += 1) {
      const local = schema.columns.find(column => column.name === foreign.columns[position]);
      const remote = target.schema.columns.find(column => column.name === foreign.targetColumns[position]);
      demand(local.type === remote.type, 'reference_type', 'Foreign key column types differ');
    }
  }
  return {
    id: key(input.id),
    name: label(input.name),
    owner: owner.id,
    description: input.description ? label(input.description, 'description', 1000) : '',
    schema,
    schemaHash: checksum(schema),
    schemaRevision: 1,
    schemaHistory: [{revision: 1, hash: checksum(schema), schema}],
    gate,
    nextVersion: 1,
    current: null,
  };
}
export function addDataset(index, input, actor) {
  const dataset = datasetSpec(index, input);
  demand(!index.datasets[dataset.id], 'dataset_exists', 'Dataset already exists');
  requireSteward(index, dataset.owner, actor);
  index.datasets[dataset.id] = dataset;
  return {result: {dataset}, audit: {dataset: dataset.id, schemaHash: dataset.schemaHash}};
}
export function requireSteward(index, owner, actor) {
  key(actor, 'actor');
  const organization = found(index.organizations, owner, 'Organization');
  demand(organization.enabled, 'organization_disabled', 'Organization is disabled');
  demand(organization.stewards.includes(actor), 'steward', 'Actor is not a steward for this organization', {}, 403);
  return organization;
}
export function reviseSchema(index, input, actor) {
  fields(input, ['dataset', 'schema', 'expectedRevision'], ['dataset', 'schema', 'expectedRevision']);
  const dataset = found(index.datasets, key(input.dataset), 'Dataset');
  requireSteward(index, dataset.owner, actor);
  count(input.expectedRevision, 'expectedRevision', 1);
  demand(input.expectedRevision === dataset.schemaRevision, 'schema_stale', 'Schema revision changed', {}, 409);
  const candidate = datasetSpec(index, {id: dataset.id, name: dataset.name, owner: dataset.owner,
    description: dataset.description || undefined, schema: input.schema, gate: dataset.gate});
  const compatibility = compareSchemas(dataset.schema, candidate.schema);
  demand(compatibility.compatible, 'schema_incompatible', 'Schema change is incompatible', compatibility);
  const hash = checksum(candidate.schema);
  if (hash === dataset.schemaHash) {
    return {noChange: true, result: {dataset}};
  }
  dataset.schema = candidate.schema;
  dataset.schemaHash = hash;
  dataset.schemaRevision += 1;
  dataset.schemaHistory.push({revision: dataset.schemaRevision, hash, schema: candidate.schema});
  return {result: {dataset}, audit: {dataset: dataset.id, schemaRevision: dataset.schemaRevision}};
}
export function versionRecord(index, reference) {
  return found(index.versions, reference, 'Dataset version');
}
export function usableVersion(index, reference) {
  const version = versionRecord(index, reference);
  demand(version.status === 'active', 'version_unavailable', 'Version is not active', {reference, status: version.status});
  for (const dependency of version.dependencies) {
    const parent = versionRecord(index, dependency);
    demand(parent.status === 'active', 'dependency_unavailable', 'Version dependency is no longer active', {dependency});
  }
  return version;
}
export function activateVersion(index, input, actor) {
  fields(input, ['dataset', 'version', 'expectedCurrent'], ['dataset', 'version']);
  const dataset = found(index.datasets, key(input.dataset), 'Dataset');
  requireSteward(index, dataset.owner, actor);
  const reference = versionKey(dataset.id, input.version);
  const version = versionRecord(index, reference);
  demand(version.status === 'validated' || version.status === 'active', 'version_state', 'Only validated versions can activate');
  demand(input.expectedCurrent === undefined || input.expectedCurrent === dataset.current,
    'activation_stale', 'Current dataset pointer changed', {current: dataset.current}, 409);
  for (const dependency of version.dependencies) {
    usableVersion(index, dependency);
  }
  if (dataset.current === reference && version.status === 'active') {
    return {noChange: true, result: {reference, active: true}};
  }
  version.status = 'active';
  dataset.current = reference;
  return {result: {reference, active: true}, audit: {reference}};
}
