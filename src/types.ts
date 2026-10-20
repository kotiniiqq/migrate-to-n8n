/** Shared shapes: the neutral source graph both parsers produce, the n8n workflow we emit, and the report. */

export type Source = 'make' | 'zapier';
export type Status = 'converted' | 'review' | 'manual';

export interface Condition {
  left: string;
  op: string;
  right?: string;
}

/** OR of AND groups: Make filters and Zapier filters/paths both use this shape. */
export type ConditionGroup = Condition[][];

export interface SourceStep {
  id: string;
  /** `app:action` as the source names it, e.g. `google-sheets:addRow` or `SlackCLIAPI:channel_message`. */
  key: string;
  app: string;
  action: string;
  label: string;
  params: Record<string, unknown>;
  position?: [number, number];
  /** Condition that must hold before this step runs (Make filter on the link into the module). */
  filter?: ConditionGroup;
  filterLabel?: string;
  /** Make error-handler directive, e.g. `builtin:Ignore`. */
  onError?: string;
  /** Module keys of a Make error-handler route that does more than one directive. */
  errorHandler?: string[];
  connectionRef?: string;
}

export interface SourceEdge {
  from: string;
  to: string;
  branch?: { index: number; label?: string; condition?: ConditionGroup };
}

export interface SourceGraph {
  source: Source;
  name: string;
  steps: SourceStep[];
  edges: SourceEdge[];
  schedule?: { kind: 'interval' | 'cron' | 'instant' | 'daily' | 'weekly' | 'monthly' | 'once'; value?: string | number };
}

export interface N8nNode {
  id: string;
  name: string;
  type: string;
  typeVersion: number;
  position: [number, number];
  parameters: Record<string, unknown>;
  credentials?: Record<string, { id: string; name: string }>;
  disabled?: boolean;
  onError?: 'continueRegularOutput' | 'continueErrorOutput' | 'stopWorkflow';
  notes?: string;
  webhookId?: string;
  retryOnFail?: boolean;
  maxTries?: number;
  waitBetweenTries?: number;
}

export interface N8nConnectionTarget {
  node: string;
  type: 'main';
  index: number;
}

export interface N8nWorkflow {
  name: string;
  nodes: N8nNode[];
  connections: Record<string, { main: N8nConnectionTarget[][] }>;
  settings: { executionOrder: 'v1' };
  pinData?: Record<string, never>;
}

export interface StepReport {
  sourceId: string;
  sourceLabel: string;
  sourceKey: string;
  n8nNodes: string[];
  status: Status;
  notes: string[];
  suggestion?: string;
}

export interface ConversionReport {
  source: Source;
  workflowName: string;
  totals: Record<Status, number>;
  steps: StepReport[];
  credentials: Array<{ app: string; credentialType: string; nodes: string[] }>;
  webhooks: Array<{ node: string; path: string }>;
  placeholders: Array<{ node: string; field: string; value: string }>;
  nextSteps: string[];
}

export interface ConversionResult {
  workflow: N8nWorkflow;
  report: ConversionReport;
}

/** A problem with what the user gave us. The message is shown as is, so it is one plain sentence. */
export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InputError';
  }
}
