import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Harbor} from './service.js';
import {HarborError, decode, demand, count} from './primitives.js';
import {serve} from './api.js';
import {verifyBackup, restoreVault} from './maintenance.js';

export function parseArguments(argv) {
  const [command = 'help', ...rest] = argv;
  const options = {};
  for (let position = 0; position < rest.length; position += 2) {
    const option = rest[position];
    const value = rest[position + 1];
    demand(option.startsWith('--') && value !== undefined, 'arguments', 'Options require --name value pairs');
    const name = option.slice(2);
    demand(!Object.hasOwn(options, name), 'arguments', 'Repeated command option');
    demand(['root', 'input', 'actor', 'id', 'destination', 'port', 'generation'].includes(name), 'arguments', 'Unknown command option');
    options[name] = value;
  }
  return {command, options};
}
export async function runCommand(argv) {
  const {command, options} = parseArguments(argv);
  if (command === 'help') {
    return {
      usage: 'node src/main.js COMMAND --root DIRECTORY --actor STEWARD --input JSON_FILE',
      commands: [
        'derive', 'preview-derive', 'owner-report', 'recipient-report', 'audit-export', 'storage-report', 'worklist', 'organization', 'dataset', 'schema', 'import', 'preview-import', 'repair', 'activate',
        'grant', 'request', 'decide', 'cancel', 'expire', 'release', 'fetch', 'proof',
        'withdraw', 'retire', 'retirement-impact', 'revoke', 'suspend', 'rows', 'compare',
        'rejected', 'risk', 'lineage', 'catalog', 'status', 'verify', 'budget', 'request-status',
        'audit', 'changes', 'preview-changes', 'orphans', 'collect', 'backup', 'backup-verify',
        'restore', 'recover-lock', 'serve',
      ],
      runtime: 'Node.js 22, local files only; no installation during startup.',
      privacy: 'Use synthetic data for demonstration; runtime tokenization key stays in the vault.',
    };
  }
  demand(options.root, 'arguments', '--root is required');
  const harbor = new Harbor(options.root);
  const actor = options.actor;
  let input = {};
  if (options.input && !['restore', 'backup-verify'].includes(command)) {
    const stat = await fs.stat(options.input);
    demand(stat.isFile() && stat.size <= 32 * 1024 * 1024, 'input_size', 'Input must be a bounded regular file');
    input = decode(await fs.readFile(options.input, 'utf8'));
  }
  switch (command) {
    case 'derive':
      return harbor.derive(input, actor);
    case 'preview-derive':
      return harbor.previewDerive(input, actor);
    case 'owner-report':
      return harbor.ownerReport(options.id, actor);
    case 'recipient-report':
      return harbor.recipientReport(options.id, actor);
    case 'audit-export':
      return harbor.auditExport(input, actor);
    case 'storage-report':
      return harbor.storageReport();
    case 'worklist':
      return harbor.worklist(actor);
    case 'organization':
      return harbor.organization(input, actor);
    case 'dataset':
      return harbor.dataset(input, actor);
    case 'schema':
      return harbor.schema(input, actor);
    case 'import':
      return harbor.import(input, actor, options.generation === undefined ? undefined : count(Number(options.generation), 'generation'));
    case 'preview-import':
      return harbor.previewImport(input, actor);
    case 'repair':
      return harbor.repair(input, actor);
    case 'activate':
      return harbor.activate(input, actor);
    case 'grant':
      return harbor.grant(input, actor);
    case 'request':
      return harbor.request(input, actor);
    case 'decide':
      return harbor.decide(input, actor);
    case 'cancel':
      return harbor.cancel(input, actor);
    case 'expire':
      return harbor.expire(actor);
    case 'release':
      return harbor.release(input, actor);
    case 'fetch':
      return harbor.fetchRelease(options.id, actor);
    case 'proof':
      return harbor.proof(options.id, actor);
    case 'withdraw':
      return harbor.withdraw(input, actor);
    case 'retire':
      return harbor.retire(input, actor);
    case 'retirement-impact':
      return harbor.retirementImpact(options.id, actor);
    case 'revoke':
      return harbor.revoke(input, actor);
    case 'suspend':
      return harbor.suspend(input, actor);
    case 'rows':
      return harbor.rows(input, actor);
    case 'compare':
      return harbor.compare(input, actor);
    case 'rejected':
      return harbor.rejected(options.id, actor);
    case 'risk':
      return harbor.risk(input, actor);
    case 'lineage':
      return harbor.lineage(options.id, actor);
    case 'catalog':
      return harbor.catalog();
    case 'status':
      return harbor.status();
    case 'verify':
      return harbor.verify();
    case 'budget':
      return harbor.budget(options.id);
    case 'request-status':
      return harbor.requestStatus(options.id);
    case 'audit':
      return harbor.audit(input);
    case 'changes':
      return harbor.changes(input, actor);
    case 'preview-changes':
      return harbor.previewChanges(input, actor);
    case 'orphans':
      return harbor.orphans();
    case 'collect':
      return harbor.collect(input);
    case 'backup':
      demand(options.destination, 'arguments', '--destination is required');
      return harbor.backup(options.destination);
    case 'backup-verify':
      return verifyBackup(options.input);
    case 'restore':
      return restoreVault(options.input, options.destination);
    case 'recover-lock':
      return harbor.recoverLock();
    case 'serve': {
      const server = await serve(harbor, {port: Number(options.port ?? 8090), token: process.env.HARBOR_API_TOKEN});
      process.once('SIGINT', () => server.close());
      process.once('SIGTERM', () => server.close());
      return {listening: server.address(), authentication: true};
    }
    default:
      demand(false, 'command', 'Unknown command');
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const output = await runCommand(process.argv.slice(2));
    process.stdout.write(JSON.stringify(output, null, 2) + String.fromCharCode(10));
  } catch (error) {
    const document = error instanceof HarborError ? error.document() : {error: 'internal', message: error.message};
    process.stderr.write(JSON.stringify(document) + String.fromCharCode(10));
    process.exitCode = 1;
  }
}
