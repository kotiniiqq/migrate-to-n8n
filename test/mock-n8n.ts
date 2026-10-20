/** In-process mock of the n8n public API, strict like the real one: unknown body, settings or node fields
 *  are a 400. It records every request so tests can prove that nothing but one create call happens. */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const BODY_KEYS = ['name', 'nodes', 'connections', 'settings', 'staticData', 'pinData'];
const SETTINGS_KEYS = ['executionOrder', 'timezone', 'errorWorkflow', 'saveManualExecutions', 'saveExecutionProgress', 'callerPolicy'];
const NODE_KEYS = ['id', 'name', 'webhookId', 'disabled', 'notesInFlow', 'notes', 'type', 'typeVersion', 'executeOnce',
  'alwaysOutputData', 'retryOnFail', 'maxTries', 'waitBetweenTries', 'continueOnFail', 'onError', 'position', 'parameters', 'credentials'];

export interface MockN8n {
  url: string;
  apiKey: string;
  store: Map<string, any>;
  requests: string[];
  /** Answer the next request with this status (and the real API's message shape). */
  failNext(status: number): void;
  /** Delay every answer (for timeouts). */
  delay(ms: number): void;
  close(): Promise<void>;
}

export async function startMockN8n(): Promise<MockN8n> {
  const store = new Map<string, any>();
  const requests: string[] = [];
  let fail: number | null = null;
  let wait = 0;
  let seq = 0;
  const apiKey = 'test-key';

  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    setTimeout(() => {
      if (res.destroyed) return;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    }, wait);
  };
  const invalid = (body: any): string | null => {
    const extra = Object.keys(body ?? {}).filter((k) => !BODY_KEYS.includes(k));
    if (extra.length) return `request/body must NOT have additional properties (${extra.join(', ')})`;
    if (!body?.name || !Array.isArray(body.nodes) || typeof body.connections !== 'object' || typeof body.settings !== 'object') {
      return 'request/body must have required properties name, nodes, connections, settings';
    }
    const extraSettings = Object.keys(body.settings).filter((k) => !SETTINGS_KEYS.includes(k));
    if (extraSettings.length) return `request/body/settings must NOT have additional properties (${extraSettings.join(', ')})`;
    for (const n of body.nodes) {
      const extraNode = Object.keys(n).filter((k) => !NODE_KEYS.includes(k));
      if (extraNode.length) return `request/body/nodes must NOT have additional properties (${extraNode.join(', ')})`;
    }
    return null;
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      requests.push(`${req.method} ${req.url}`);
      if (fail !== null) {
        const status = fail;
        fail = null;
        return send(res, status, { message: status === 401 ? 'unauthorized' : `failed with ${status}` });
      }
      if (req.headers['x-n8n-api-key'] !== apiKey) return send(res, 401, { message: 'unauthorized' });
      if (req.method === 'POST' && req.url === '/api/v1/workflows') {
        const body = raw ? JSON.parse(raw) : {};
        const problem = invalid(body);
        if (problem) return send(res, 400, { message: problem });
        const id = `wf${++seq}`;
        const saved = { ...body, id, active: false, createdAt: new Date().toISOString() };
        store.set(id, saved);
        return send(res, 200, saved);
      }
      const get = /^\/api\/v1\/workflows\/([^/?]+)$/.exec(req.url ?? '');
      if (req.method === 'GET' && get) return store.has(get[1]) ? send(res, 200, store.get(get[1])) : send(res, 404, { message: 'Not Found' });
      return send(res, 404, { message: 'Not Found' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    apiKey,
    store,
    requests,
    failNext: (status) => { fail = status; },
    delay: (ms) => { wait = ms; },
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}
