/** Talking to the throwaway n8n instances of docker-compose.e2e.yml: owner setup, an API key, small API calls.
 *  Uses n8n's internal REST endpoints for the setup screen (test values only, local instances only). */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Set N8N1_URL or N8N2_URL to "skip" to test one version only (CI runs 2.x). */
export const INSTANCES = [
  { name: 'n8n 2.44.4', url: process.env.N8N2_URL ?? 'http://127.0.0.1:5678' },
  { name: 'n8n 1.123.85', url: process.env.N8N1_URL ?? 'http://127.0.0.1:5679' },
].filter((i) => i.url !== 'skip');

const json = { 'content-type': 'application/json' };

export async function waitReady(url: string, seconds = 180): Promise<void> {
  for (let i = 0; i < seconds; i++) {
    try {
      const r = await fetch(`${url}/healthz/readiness`);
      if (r.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${url} did not become ready`);
}

/** Owner account + API key on a fresh instance (or log in if the owner exists). Returns the API key. */
export async function apiKey(url: string): Promise<string> {
  // The key of an instance set up by an earlier run (same containers) is kept in .cache.
  const file = join('.cache', 'e2e', `${new URL(url).port || '80'}.key`);
  if (existsSync(file)) {
    const cached = readFileSync(file, 'utf8').trim();
    const probe = await fetch(`${url}/api/v1/workflows?limit=1`, { headers: { 'X-N8N-API-KEY': cached } });
    if (probe.ok) return cached;
  }
  const key = await createKey(url);
  mkdirSync(join('.cache', 'e2e'), { recursive: true });
  writeFileSync(file, key);
  return key;
}

async function createKey(url: string): Promise<string> {
  const owner = { email: 'owner@example.com', firstName: 'E2E', lastName: 'Test', password: `E2e-${randomBytes(6).toString('hex')}A1` };
  const setup = await fetch(`${url}/rest/owner/setup`, { method: 'POST', headers: json, body: JSON.stringify(owner) });
  let cookie = setup.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  if (!setup.ok) {
    throw new Error(`owner setup failed (${setup.status}); start from fresh containers: docker compose -f docker-compose.e2e.yml down && up -d`);
  }
  if (!cookie) {
    const login = await fetch(`${url}/rest/login`, { method: 'POST', headers: json, body: JSON.stringify({ emailOrLdapLoginId: owner.email, email: owner.email, password: owner.password }) });
    cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  }
  const headers = { ...json, cookie, 'browser-id': 'migrate-to-n8n-e2e' };
  const scopesRes = await fetch(`${url}/rest/api-keys/scopes`, { headers });
  const scopes = scopesRes.ok ? (await scopesRes.json()).data : undefined;
  const body: Record<string, unknown> = { label: `e2e-${Date.now()}`, expiresAt: null };
  if (scopes) body.scopes = scopes;
  const key = await fetch(`${url}/rest/api-keys`, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!key.ok) throw new Error(`api key: ${key.status} ${(await key.text()).slice(0, 200)}`);
  const data = (await key.json()).data;
  return data.rawApiKey ?? data.apiKey;
}

export async function api(url: string, key: string, method: string, path: string, body?: unknown): Promise<any> {
  const r = await fetch(`${url}/api/v1${path}`, { method, headers: { ...json, 'X-N8N-API-KEY': key }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

/** Make a workflow live. `/activate` registers the webhooks in both n8n 1.x and 2.x (in 2.x it publishes the
 *  current version); give n8n a moment to register them. */
export async function activate(url: string, key: string, id: string): Promise<void> {
  await api(url, key, 'POST', `/workflows/${id}/activate`);
  await new Promise((r) => setTimeout(r, 1000));
}

/** Remove what earlier runs left on a test instance (only workflows this tool created: "… (migrated)"). */
export async function cleanup(url: string, key: string): Promise<void> {
  const list = await api(url, key, 'GET', '/workflows?limit=250');
  for (const w of list.data ?? []) {
    if (!String(w.name).endsWith(' (migrated)')) continue;
    if (w.active) await api(url, key, 'POST', `/workflows/${w.id}/deactivate`).catch(() => {});
    await api(url, key, 'DELETE', `/workflows/${w.id}`).catch(() => {});
  }
}
