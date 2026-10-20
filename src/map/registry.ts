import type { PlannedNode } from '../build/workflow.ts';
import type { Source, SourceGraph, SourceStep, Status } from '../types.ts';

/** Node types the converter emits, at the highest typeVersion n8n 2.44 and 1.123 both know (checked by test/registry.test.ts). */
export const NODE: Record<string, { type: string; typeVersion: number }> = {
  httpRequest: { type: 'n8n-nodes-base.httpRequest', typeVersion: 4.3 },
  webhook: { type: 'n8n-nodes-base.webhook', typeVersion: 2.1 },
  respondToWebhook: { type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.5 },
  scheduleTrigger: { type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.3 },
  manualTrigger: { type: 'n8n-nodes-base.manualTrigger', typeVersion: 1 },
  set: { type: 'n8n-nodes-base.set', typeVersion: 3.4 },
  code: { type: 'n8n-nodes-base.code', typeVersion: 2 },
  'if': { type: 'n8n-nodes-base.if', typeVersion: 2.3 },
  filter: { type: 'n8n-nodes-base.filter', typeVersion: 2.3 },
  'switch': { type: 'n8n-nodes-base.switch', typeVersion: 3.4 },
  splitOut: { type: 'n8n-nodes-base.splitOut', typeVersion: 1 },
  aggregate: { type: 'n8n-nodes-base.aggregate', typeVersion: 1 },
  merge: { type: 'n8n-nodes-base.merge', typeVersion: 3.2 },
  wait: { type: 'n8n-nodes-base.wait', typeVersion: 1.1 },
  noOp: { type: 'n8n-nodes-base.noOp', typeVersion: 1 },
  stickyNote: { type: 'n8n-nodes-base.stickyNote', typeVersion: 1 },
  dataTable: { type: 'n8n-nodes-base.dataTable', typeVersion: 1 },
  dateTime: { type: 'n8n-nodes-base.dateTime', typeVersion: 2 },
  googleSheets: { type: 'n8n-nodes-base.googleSheets', typeVersion: 4.7 },
  gmail: { type: 'n8n-nodes-base.gmail', typeVersion: 2.2 },
  emailSend: { type: 'n8n-nodes-base.emailSend', typeVersion: 2.1 },
  slack: { type: 'n8n-nodes-base.slack', typeVersion: 2.4 },
  airtable: { type: 'n8n-nodes-base.airtable', typeVersion: 2.1 },
  notion: { type: 'n8n-nodes-base.notion', typeVersion: 2.2 },
  telegram: { type: 'n8n-nodes-base.telegram', typeVersion: 1.2 },
  hubspot: { type: 'n8n-nodes-base.hubspot', typeVersion: 2.2 },
  googleCalendar: { type: 'n8n-nodes-base.googleCalendar', typeVersion: 1.3 },
  microsoftExcel: { type: 'n8n-nodes-base.microsoftExcel', typeVersion: 2.2 },
  rssFeedRead: { type: 'n8n-nodes-base.rssFeedRead', typeVersion: 1.2 },
  openAi: { type: '@n8n/n8n-nodes-langchain.openAi', typeVersion: 2.1 },
};

// ---------- the mapping table ----------


/** What a mapping entry can ask while it builds the n8n side of one source step. */
export interface MapCtx {
  step: SourceStep;
  graph: SourceGraph;
  /** Source value (text with formulas, or nested objects/lists of them) → n8n parameter value. */
  expr(value: unknown): unknown;
  /** Source value → one JavaScript expression (for Code nodes and composed expressions). */
  js(value: unknown): string;
  /** Add a note to the report; `review` also lowers the step to at least "review". */
  note(text: string, review?: boolean): void;
  /** Whether the scenario has a step with this key. */
  has(key: string): boolean;
  /** n8n node name that holds the value of a source variable, if a step sets it. */
  variable(name: string): string | undefined;
  /** URL-safe version of the scenario name. */
  slug: string;
  /** n8n node whose output arrives directly at this step (one plain incoming link, no filter), if any. */
  previous?: string;
}

export type MapNode = Omit<PlannedNode, 'key' | 'sourcePosition'>;

export interface MapOutput {
  /** Run in this order; the last node holds the step's output. Empty for steps that need no node. */
  nodes: MapNode[];
  status: Status;
  notes?: string[];
  suggestion?: string;
  credential?: { app: string; credentialType: string };
  webhookPath?: string;
  placeholders?: Array<{ field: string; value: string }>;
  /** How formulas read this step's output, when not `$('Out').item.json.<path>`. May throw to refuse a field. */
  ref?(outName: string, firstField?: string): { base: string; drop: number; note?: string } | undefined;
  /** Source variables this step sets; later reads point to the output node. */
  sets?: string[];
}

export interface MappingEntry {
  source: Source;
  /** Exact source key, or `app:*` for every action of an app. */
  key: string;
  /** What the step becomes, for the supported-modules table. */
  label: string;
  build(ctx: MapCtx): MapOutput;
}

const ENTRIES = new Map<string, MappingEntry>();

export function register(...entries: MappingEntry[]): void {
  for (const e of entries) ENTRIES.set(`${e.source}|${e.key}`, e);
}

export function findEntry(source: Source, key: string): MappingEntry | undefined {
  return ENTRIES.get(`${source}|${key}`) ?? ENTRIES.get(`${source}|${key.split(':')[0]}:*`);
}

export function allEntries(source?: Source): MappingEntry[] {
  return [...ENTRIES.values()].filter((e) => !source || e.source === source);
}

const RANK: Record<Status, number> = { converted: 0, review: 1, manual: 2 };
export const worst = (a: Status, b: Status): Status => (RANK[a] >= RANK[b] ? a : b);

/** A planned node of a known type at the shared typeVersion. */
export function n8nNode(kind: keyof typeof NODE & string, wanted: string, parameters: Record<string, unknown>, extra: Partial<MapNode> = {}): MapNode {
  const t = NODE[kind];
  if (!t) throw new Error(`unknown node kind ${kind}`);
  return { wanted, type: t.type, typeVersion: t.typeVersion, parameters, ...extra };
}
