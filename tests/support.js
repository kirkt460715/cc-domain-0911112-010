import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Harbor} from '../src/service.js';
export async function setup(t, {dataset = true, imported = true, active = true, gate} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harbor-test-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  let time = '2026-11-01T00:00:00Z';
  const clock = () => new Date(time);
  const harbor = new Harbor(root, {clock});
  await harbor.organization({id: 'owner', name: 'Synthetic institute', region: 'south',
    purposes: ['research'], stewards: ['alice', 'bob']}, 'bootstrap');
  await harbor.organization({id: 'partner', name: 'Synthetic partner', region: 'south',
    purposes: ['research'], stewards: ['carol']}, 'bootstrap');
  if (dataset) {
    await harbor.dataset(datasetInput(gate ? {gate} : {}), 'alice');
    if (imported) {
      await harbor.import({dataset: 'people', importId: 'initial', rows: rows()}, 'alice');
      if (active) {
        await harbor.activate({dataset: 'people', version: 1}, 'alice');
      }
    }
  }
  return {root, harbor, clock, setTime: value => {time = value;}};
}
export function schema() {
  return {columns: [
    {name: 'id', type: 'string', classification: 'sensitive'},
    {name: 'district', type: 'string', classification: 'public'},
    {name: 'hours', type: 'integer', classification: 'public', minimum: 0},
    {name: 'note', type: 'string', classification: 'restricted', nullable: true},
  ], primaryKey: ['id']};
}
export function datasetInput(overrides = {}) {
  return {id: 'people', name: 'Synthetic participation', owner: 'owner', schema: schema(), ...overrides};
}
export function rows() {
  return [
    {id: 'a', district: 'delta', hours: 10, note: 'local-only-a'},
    {id: 'b', district: 'delta', hours: 20, note: null},
    {id: 'c', district: 'hill', hours: 30, note: 'local-only-c'},
  ];
}
export function grant(overrides = {}) {
  return {id: 'g', dataset: 'people', recipient: 'partner', purposes: ['research'],
    columns: ['id', 'district', 'hours'], transforms: {id: {kind: 'tokenize'}},
    rowBudget: 20, expiresAt: '2026-12-01T00:00:00Z', minimumGroup: 2,
    quasiIdentifiers: ['district'], approvalCount: 2, ...overrides};
}
export function request(overrides = {}) {
  return {id: 'q', grant: 'g', reference: 'people:1', recipient: 'partner', purpose: 'research',
    columns: ['id', 'district', 'hours'], expiresAt: '2026-11-20T00:00:00Z', ...overrides};
}
export async function approved(harbor, overrides = {}) {
  await harbor.grant(grant(overrides), 'alice');
  await harbor.request(request(), 'carol');
  await harbor.decide({id: 'q', decision: 'approve', reason: 'purpose checked'}, 'alice');
  await harbor.decide({id: 'q', decision: 'approve', reason: 'disclosure checked'}, 'bob');
}
export function kind(expected) {
  return error => error.kind === expected;
}
