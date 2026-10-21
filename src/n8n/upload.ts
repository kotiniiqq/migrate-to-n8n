/** Send a converted workflow to the user's own n8n. Creates it inactive; never changes anything else. */
import { setting } from '../convert.ts';
import type { N8nWorkflow } from '../types.ts';

export interface UploadConfig {
  url: string;
  apiKey: string;
}

/** From N8N_URL and N8N_API_KEY; null unless both are set (unfilled Claude Desktop settings count as unset). */
export function uploadConfig(env: Record<string, string | undefined> = process.env): UploadConfig | null {
  const url = setting(env.N8N_URL);
  const apiKey = setting(env.N8N_API_KEY);
  return url && apiKey ? { url, apiKey } : null;
}

// What the public API accepts (n8n 1.123 and 2.44); anything else in the file (ids, tags, read-only fields) is left out.
const NODE_FIELDS = ['id', 'name', 'webhookId', 'disabled', 'notesInFlow', 'notes', 'type', 'typeVersion', 'executeOnce', 'alwaysOutputData',
  'retryOnFail', 'maxTries', 'waitBetweenTries', 'continueOnFail', 'onError', 'position', 'parameters', 'credentials'];
const SETTINGS_FIELDS = ['executionOrder', 'timezone', 'errorWorkflow', 'saveManualExecutions', 'saveExecutionProgress', 'callerPolicy'];

const pick = (o: unknown, keys: string[]) => Object.fromEntries(Object.entries(o && typeof o === 'object' ? o : {}).filter(([k]) => keys.includes(k)));

export async function uploadWorkflow(w: N8nWorkflow, cfg: UploadConfig, opts: { timeoutMs?: number } = {}): Promise<{ id: string; url: string; active: false }> {
  const base = cfg.url.trim().replace(/\/+$/, '').replace(/\/api\/v1$/, '');
  let host: string;
  try {
    host = new URL(base).host;
  } catch {
    throw new Error(`N8N_URL is not a web address: ${cfg.url}`);
  }
  // Any n8n workflow file can come here (an edited conversion, a copy from n8n without a name).
  const name = typeof w.name === 'string' && w.name.trim() ? w.name : 'Workflow';
  const { staticData } = w as { staticData?: unknown };
  const body = {
    name: `${[...name].slice(0, 128 - ' (migrated)'.length).join('').trim()} (migrated)`,
    nodes: w.nodes.map((n) => pick(n, NODE_FIELDS)),
    connections: w.connections,
    settings: { executionOrder: 'v1', ...pick(w.settings, SETTINGS_FIELDS) },
    ...(staticData && typeof staticData === 'object' ? { staticData } : {}),
  };
  const timeoutMs = opts.timeoutMs ?? 20_000;
  let res: Response;
  try {
    res = await fetch(`${base}/api/v1/workflows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'X-N8N-API-KEY': cfg.apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      // Never follow a redirect: the API key must only go to the address the user configured.
      redirect: 'manual',
    });
  } catch (e) {
    if ((e as Error).name === 'TimeoutError') throw new Error(`n8n at ${host} did not answer within ${Math.round(timeoutMs / 1000)} s.`);
    throw new Error(`Could not reach ${host}: ${(e as { cause?: { code?: string } }).cause?.code ?? (e as Error).message}.`);
  }
  if (res.status >= 300 && res.status < 400) {
    throw new Error(`N8N_URL redirects to ${res.headers.get('location') ?? 'another address'}: set N8N_URL to that address (nothing was sent there).`);
  }
  const text = await res.text();
  let json: { id?: string; message?: string } = {};
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON: handled by the status checks below
  }
  if (res.status === 401 || res.status === 403) throw new Error('n8n rejected the API key (N8N_API_KEY): create one in n8n under Settings → n8n API.');
  if (res.status === 404) throw new Error(`${base} does not look like an n8n instance with the public API (no /api/v1/workflows).`);
  if (!res.ok || !json.id) throw new Error(`n8n refused the workflow: ${json.message ?? `HTTP ${res.status}`}`);
  return { id: json.id, url: `${base}/workflow/${json.id}`, active: false };
}
