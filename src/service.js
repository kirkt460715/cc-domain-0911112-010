import {Vault} from './vault.js';
import {deriveVersion, prepareDerivation} from './derive.js';
import * as governance from './governance.js';
import {key, found, demand, utcNow} from './primitives.js';
import * as registry from './registry.js';
import * as importer from './importer.js';
import * as policy from './policy.js';
import * as requests from './requests.js';
import * as releases from './releases.js';
import * as revocation from './revocation.js';
import * as inspection from './inspection.js';
import * as integrity from './integrity.js';
import * as maintenance from './maintenance.js';
import * as changes from './changes.js';
import * as bundles from './bundles.js';

export class Harbor {
  constructor(root, {clock = () => new Date(), lockTimeout = 5000} = {}) {
    this.vault = new Vault(root, {timeout: lockTimeout});
    this.clock = clock;
  }
  now() {
    return utcNow(this.clock);
  }
  async write(actor, operation, action, expectedGeneration) {
    key(actor, 'actor');
    return this.vault.update(actor, operation, index => action(index, this.now()), expectedGeneration);
  }
  async read(action) {
    return this.vault.exclusive(async () => action(await this.vault.readIndex(), this.now()));
  }
  async derive(input, actor) {
    return this.write(actor, 'version.derive', index => deriveVersion(this.vault, index, input, actor));
  }
  async previewDerive(input, actor) {
    return this.read(async index => {
      const prepared = await prepareDerivation(this.vault, index, input, actor);
      return {generation: index.generation, report: prepared.report, dependencies: prepared.dependencies};
    });
  }
  async ownerReport(owner, actor) {
    return this.read(index => governance.ownerReport(index, owner, actor));
  }
  async recipientReport(recipient, actor) {
    return this.read(index => governance.recipientReport(index, recipient, actor));
  }
  async auditExport(input, actor) {
    return this.read(index => governance.auditExport(index, input, actor));
  }
  async storageReport() {
    return this.read(index => governance.storageReport(index));
  }
  async worklist(actor) {
    return this.read((index, at) => governance.approvalWorklist(index, actor, at));
  }
  async organization(input, actor) {
    return this.write(actor, 'organization.register', index => registry.addOrganization(index, input));
  }
  async dataset(input, actor) {
    return this.write(actor, 'dataset.register', index => registry.addDataset(index, input, actor));
  }
  async schema(input, actor) {
    return this.write(actor, 'schema.revise', index => registry.reviseSchema(index, input, actor));
  }
  async import(input, actor, expectedGeneration) {
    return this.write(actor, 'version.import', index => importer.importVersion(this.vault, index, input, actor), expectedGeneration);
  }
  async previewImport(input, actor) {
    return this.read(index => importer.importPreview(this.vault, index, input, actor));
  }
  async repair(input, actor) {
    return this.write(actor, 'version.repair', index => importer.repairImport(this.vault, index, input, actor));
  }
  async activate(input, actor) {
    return this.write(actor, 'version.activate', index => registry.activateVersion(index, input, actor));
  }
  async grant(input, actor) {
    return this.write(actor, 'grant.create', (index, at) => policy.addGrant(index, input, actor, at));
  }
  async request(input, actor) {
    return this.write(actor, 'request.create', (index, at) => requests.proposeRequest(this.vault, index, input, actor, at));
  }
  async decide(input, actor) {
    return this.write(actor, 'request.decide', (index, at) => requests.decideRequest(index, input, actor, at));
  }
  async cancel(input, actor) {
    return this.write(actor, 'request.cancel', index => requests.cancelRequest(index, input, actor));
  }
  async expire(actor) {
    return this.write(actor, 'request.expire', (index, at) => requests.expireRequests(index, at));
  }
  async release(input, actor) {
    return this.write(actor, 'release.create', (index, at) => releases.materializeRelease(this.vault, index, input, actor, at));
  }
  async fetchRelease(id, actor) {
    return this.read(async (index, at) => {
      const release = found(index.releases, key(id), 'Release');
      const grant = index.grants[release.grant];
      const recipient = index.organizations[release.recipient];
      const owner = index.organizations[grant.owner];
      demand(recipient.stewards.includes(actor) || owner.stewards.includes(actor), 'release_actor',
        'Actor cannot retrieve this release', {}, 403);
      return releases.readableRelease(this.vault, index, id, at);
    });
  }
  async proof(id, actor) {
    await this.fetchRelease(id, actor);
    return this.read((index, at) => releases.releaseProof(this.vault, index, id, at));
  }
  async withdraw(input, actor) {
    return this.write(actor, 'release.withdraw', (index, at) => releases.withdrawRelease(index, input, actor, at));
  }
  async retire(input, actor) {
    return this.write(actor, 'version.retire', (index, at) => revocation.retireVersion(index, input, actor, at));
  }
  async retirementImpact(reference, actor) {
    return this.read(index => {
      const version = found(index.versions, reference, 'Version');
      registry.requireSteward(index, index.datasets[version.dataset].owner, actor);
      return revocation.previewRetirement(index, reference);
    });
  }
  async revoke(input, actor) {
    return this.write(actor, 'grant.revoke', (index, at) => revocation.revokeGrant(index, input, actor, at));
  }
  async suspend(input, actor) {
    return this.write(actor, 'organization.suspend', (index, at) => revocation.suspendOrganization(index, input, actor, at));
  }
  async rows(input, actor) {
    return this.read(index => inspection.readVersion(this.vault, index, input, actor));
  }
  async compare(input, actor) {
    return this.read(index => inspection.compareVersions(this.vault, index, input, actor));
  }
  async rejected(reference, actor) {
    return this.read(index => inspection.rejectedRows(this.vault, index, reference, actor));
  }
  async risk(input, actor) {
    return this.read(index => inspection.inspectRisk(this.vault, index, input, actor));
  }
  async lineage(reference, actor) {
    return this.read(index => {
      const version = found(index.versions, reference, 'Version');
      registry.requireSteward(index, index.datasets[version.dataset].owner, actor);
      return inspection.lineage(index, reference);
    });
  }
  async catalog() {
    return this.read(index => inspection.catalogSummary(index));
  }
  async status() {
    return this.read((index, at) => integrity.operationalStatus(index, at));
  }
  async verify() {
    return this.read(index => integrity.verifyVault(this.vault, index));
  }
  async budget(id) {
    return this.read(index => policy.remainingBudget(index, id));
  }
  async requestStatus(id) {
    return this.read(index => requests.requestSummary(index, id));
  }
  async audit({actor, operation, after = 0} = {}) {
    return this.read(index => index.audits.filter(item => item.generation > after &&
      (!actor || item.actor === actor) && (!operation || item.operation === operation)));
  }
  async previewChanges(input, actor) {
    return this.read(index => changes.previewChanges(this.vault, index, input, actor));
  }
  async changes(input, actor) {
    return this.write(actor, 'version.changes', index => changes.applyChanges(this.vault, index, input, actor));
  }
  async orphans() {
    return this.read(index => maintenance.orphanReport(this.vault, index));
  }
  async previewBundlePlan(input, actor) {
    return this.read(index => bundles.previewBundle(index, input, actor));
  }
  async planBundle(input, actor) {
    return this.write(actor, 'bundle.plan', (index, at) => bundles.planBundle(index, input, actor, at));
  }
  async ingestBundle(input, actor, expectedGeneration) {
    return this.write(actor, 'bundle.ingest',
      (index, at) => bundles.ingestBundle(this.vault, index, input, actor, at), expectedGeneration);
  }
  async activateBundle(input, actor, expectedGeneration) {
    return this.write(actor, 'bundle.activate',
      (index, at) => bundles.activateBundle(index, input, actor, at), expectedGeneration);
  }
  async abandonBundle(input, actor) {
    return this.write(actor, 'bundle.abandon', (index, at) => bundles.abandonBundle(index, input, actor, at));
  }
  async bundleStatus(id) {
    return this.read((index, at) => bundles.bundleStatus(index, id, at));
  }
  async bundleList() {
    return this.read(index => ({generation: index.generation, bundles: bundles.bundleSummary(index)}));
  }
  async bundleTrace(input) {
    return this.read(index => bundles.bundleTrace(index, input));
  }
  async collect(input) {
    return maintenance.collectOrphans(this.vault, input);
  }
  async backup(destination) {
    return maintenance.backupVault(this.vault, destination);
  }
  async recoverLock() {
    return this.vault.recoverLock();
  }
}
