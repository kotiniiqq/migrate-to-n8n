/** Which n8n node (if any) serves the app behind a Make module or Zapier step. */
import type { Source } from '../types.ts';
import { N8N_APPS } from './n8n-apps.ts';
import { NODE } from './registry.ts';

export interface AppMatch {
  type?: string;
  typeVersion?: number;
  displayName: string;
  trigger?: boolean;
  /** n8n trigger node of the same app, for suggestions. */
  triggerName?: string;
  /** Known REST API base for apps without an n8n node. */
  apiBase?: string;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Normalized app id → n8n node name (or a core node from NODE, prefixed with `core:`). */
const ALIASES: Record<string, string> = {
  googleemail: 'gmail', googlemail: 'gmail', gmail: 'gmail',
  hubspotcrm: 'hubspot', microsoft365email: 'microsoftOutlook', outlook: 'microsoftOutlook', microsoftoutlook: 'microsoftOutlook',
  monday: 'mondayCom', excel: 'microsoftExcel', microsoftexcel365: 'microsoftExcel', onedrive: 'microsoftOneDrive',
  teams: 'microsoftTeams', microsoftteams: 'microsoftTeams', x: 'twitter', twitterx: 'twitter',
  openaigpt3: 'core:openAi', openai: 'core:openAi', chatgpt: 'core:openAi',
  email: 'core:emailSend', smtp: 'core:emailSend', rss: 'core:rssFeedRead', rssfeed: 'core:rssFeedRead',
  googledrive: 'googleDrive', googledocs: 'googleDocs', googlecalendar: 'googleCalendar', googlesheets: 'googleSheets',
  whatsapp: 'whatsApp', whatsappbusinesscloud: 'whatsApp', zohocrm: 'zohoCrm', woocommerce: 'wooCommerce',
  activecampaign: 'activeCampaign', clickup: 'clickUp', mailerlite: 'mailerLite', convertkit: 'convertKit',
  sendgrid: 'sendGrid', mailgun: 'mailgun', freshdesk: 'freshdesk', helpscout: 'helpScout', jira: 'jira', jirasoftware: 'jira',
};

/** REST API bases of popular apps that have no n8n node. */
const API_BASES: Record<string, { name: string; base: string }> = {
  apify: { name: 'Apify', base: 'https://api.apify.com/v2' },
  makeaitools: { name: 'Make AI Tools', base: 'https://api.openai.com/v1' },
  anthropicclaude: { name: 'Anthropic Claude', base: 'https://api.anthropic.com/v1' },
  perplexity: { name: 'Perplexity', base: 'https://api.perplexity.ai' },
  elevenlabs: { name: 'ElevenLabs', base: 'https://api.elevenlabs.io/v1' },
  tally: { name: 'Tally', base: 'https://api.tally.so' },
  instantly: { name: 'Instantly', base: 'https://api.instantly.ai/api/v2' },
  apollo: { name: 'Apollo', base: 'https://api.apollo.io/api/v1' },
  manychat: { name: 'ManyChat', base: 'https://api.manychat.com' },
  heygen: { name: 'HeyGen', base: 'https://api.heygen.com' },
};

const BY_NORM = new Map<string, readonly [string, string, number]>();
for (const app of N8N_APPS) BY_NORM.set(norm(app[0]), app);

/** Make app slug or Zapier `selected_api` → a lookup key. */
function appKey(source: Source, app: string): string | undefined {
  if (source === 'make') {
    if (app.startsWith('app#')) return undefined; // a private custom app
    return norm(app);
  }
  return norm(app.replace(/@.*$/, '').replace(/(V\d+)?(CLI)?API$/i, ''));
}

export function findApp(source: Source, app: string, trigger: boolean): AppMatch | undefined {
  const key = appKey(source, app);
  if (!key) return undefined;
  const alias = ALIASES[key];
  if (alias?.startsWith('core:')) {
    const n = NODE[alias.slice(5)];
    const displayName = { openAi: 'OpenAI', emailSend: 'Send Email', rssFeedRead: 'RSS Read' }[alias.slice(5)] ?? alias.slice(5);
    return { type: n.type, typeVersion: n.typeVersion, displayName };
  }
  const base = alias ? BY_NORM.get(norm(alias)) : BY_NORM.get(key);
  const trig = BY_NORM.get(norm(`${base?.[0] ?? alias ?? key}Trigger`));
  const pick = trigger && trig ? trig : base ?? trig;
  if (pick) {
    return {
      type: `n8n-nodes-base.${pick[0]}`, typeVersion: pick[2], displayName: pick[1], trigger: pick === trig,
      triggerName: trig && pick !== trig ? trig[1] : undefined,
    };
  }
  const api = API_BASES[key];
  if (api) return { displayName: api.name, apiBase: api.base };
  return undefined;
}
