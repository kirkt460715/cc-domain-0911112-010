import http from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {HarborError, decode, demand, key, count} from './primitives.js';

function authenticated(request, expected) {
  const supplied = Buffer.from(request.headers.authorization ?? '');
  const required = Buffer.from(`Bearer ${expected}`);
  return supplied.length === required.length && timingSafeEqual(supplied, required);
}
async function readBody(request, limit) {
  const data = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    demand(bytes <= limit, 'body_limit', 'Request body is too large', {}, 413);
    data.push(chunk);
  }
  if (bytes === 0) {
    return {};
  }
  demand(request.headers['content-type']?.split(';')[0] === 'application/json', 'content_type',
    'Request body must be application/json', {}, 415);
  return decode(Buffer.concat(data).toString('utf8'));
}
function respond(response, code, document) {
  const body = JSON.stringify(document);
  response.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}
export function apiServer(harbor, {token, maximumBytes = 32 * 1024 * 1024}) {
  demand(typeof token === 'string' && token.length >= 16, 'api_token', 'Local API requires a token of at least 16 characters');
  count(maximumBytes, 'maximumBytes', 1024);
  return http.createServer({requestTimeout: 30000, headersTimeout: 10000, keepAliveTimeout: 1000}, async (request, response) => {
    try {
      demand(authenticated(request, token), 'unauthorized', 'Valid bearer token is required', {}, 401);
      const actor = key(request.headers['x-actor'], 'x-actor');
      const url = new URL(request.url, 'http://localhost');
      let result;
      if (request.method === 'GET') {
        switch (url.pathname) {
          case '/status':
            result = await harbor.status();
            break;
          case '/catalog':
            result = await harbor.catalog();
            break;
          case '/verify':
            result = await harbor.verify();
            break;
          case '/budget':
            result = await harbor.budget(url.searchParams.get('id'));
            break;
          case '/request':
            result = await harbor.requestStatus(url.searchParams.get('id'));
            break;
          case '/release':
            result = await harbor.fetchRelease(url.searchParams.get('id'), actor);
            break;
          case '/lineage':
            result = await harbor.lineage(url.searchParams.get('reference'), actor);
            break;
          default:
            demand(false, 'endpoint', 'Unknown endpoint', {}, 404);
        }
      } else {
        demand(request.method === 'POST', 'method', 'Only GET and POST are supported', {}, 405);
        const input = await readBody(request, maximumBytes);
        switch (url.pathname) {
          case '/organizations':
            result = await harbor.organization(input, actor);
            break;
          case '/datasets':
            result = await harbor.dataset(input, actor);
            break;
          case '/schemas':
            result = await harbor.schema(input, actor);
            break;
          case '/imports': {
            const expected = request.headers['if-match'];
            result = await harbor.import(input, actor, expected === undefined ? undefined : count(Number(expected), 'if-match'));
            break;
          }
          case '/imports/preview':
            result = await harbor.previewImport(input, actor);
            break;
          case '/imports/repair':
            result = await harbor.repair(input, actor);
            break;
          case '/versions/activate':
            result = await harbor.activate(input, actor);
            break;
          case '/versions/rows':
            result = await harbor.rows(input, actor);
            break;
          case '/versions/compare':
            result = await harbor.compare(input, actor);
            break;
          case '/versions/changes':
            result = await harbor.changes(input, actor);
            break;
          case '/versions/retire':
            result = await harbor.retire(input, actor);
            break;
          case '/grants':
            result = await harbor.grant(input, actor);
            break;
          case '/grants/revoke':
            result = await harbor.revoke(input, actor);
            break;
          case '/requests':
            result = await harbor.request(input, actor);
            break;
          case '/requests/decide':
            result = await harbor.decide(input, actor);
            break;
          case '/requests/cancel':
            result = await harbor.cancel(input, actor);
            break;
          case '/requests/expire':
            result = await harbor.expire(actor);
            break;
          case '/releases':
            result = await harbor.release(input, actor);
            break;
          case '/releases/withdraw':
            result = await harbor.withdraw(input, actor);
            break;
          case '/risk':
            result = await harbor.risk(input, actor);
            break;
          default:
            demand(false, 'endpoint', 'Unknown endpoint', {}, 404);
        }
      }
      respond(response, 200, result);
    } catch (error) {
      if (!response.headersSent && !response.destroyed) {
        respond(response, error instanceof HarborError ? error.status : 500, error instanceof HarborError ? error.document() :
          {error: 'internal', message: 'Operation failed'});
      }
    }
  });
}
export async function serve(harbor, {port = 8090, token}) {
  count(port, 'port', 0, 65535);
  const server = apiServer(harbor, {token});
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}
