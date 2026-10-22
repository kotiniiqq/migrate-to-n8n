/** Structural check of an n8n workflow: what would stop an import or need a human before the first run. */
import { NODE } from '../map/registry.ts';

export interface CheckIssue {
  level: 'error' | 'warning' | 'info';
  rule: 'shape' | 'unique-names' | 'connections' | 'disabled' | 'placeholder' | 'trigger' | 'credentials';
  node?: string;
  message: string;
}

const PLACEHOLDER = 'REPLACE-ME';

function containsPlaceholder(value: unknown): boolean {
  if (typeof value === 'string') return value.includes(PLACEHOLDER);
  if (Array.isArray(value)) return value.some(containsPlaceholder);
  if (value && typeof value === 'object') return Object.values(value).some(containsPlaceholder);
  return false;
}

// The IMAP email trigger is the one trigger whose type name does not say so.
const isTrigger = (type: string) => (/(trigger|webhook)$/i.test(type) && type !== 'n8n-nodes-base.respondToWebhook') || type === 'n8n-nodes-base.emailReadImap';

export function checkWorkflow(w: unknown): CheckIssue[] {
  const wf = w as { nodes?: unknown; connections?: unknown };
  if (!wf || typeof wf !== 'object' || !Array.isArray(wf.nodes) || typeof wf.connections !== 'object' || wf.connections === null) {
    return [{ level: 'error', rule: 'shape', message: 'Not an n8n workflow: expected an object with "nodes" (a list) and "connections".' }];
  }
  const issues: CheckIssue[] = [];
  const nodes = wf.nodes as Array<Record<string, any>>;
  const count = new Map<string, number>();
  for (const n of nodes) count.set(n.name, (count.get(n.name) ?? 0) + 1);
  for (const [name, c] of count) {
    if (c > 1) issues.push({ level: 'error', rule: 'unique-names', node: name, message: `${c} nodes are named "${name}"; n8n needs unique names.` });
  }
  for (const [from, outputs] of Object.entries(wf.connections as Record<string, any>)) {
    if (!count.has(from)) issues.push({ level: 'error', rule: 'connections', node: from, message: `A connection starts at "${from}", which is not in the workflow.` });
    for (const targets of (outputs?.main ?? []) as any[][]) {
      for (const t of targets ?? []) {
        if (!count.has(t?.node)) issues.push({ level: 'error', rule: 'connections', node: from, message: `"${from}" connects to "${t?.node}", which is not in the workflow.` });
      }
    }
  }
  for (const n of nodes) {
    if (n.type === NODE.stickyNote.type) continue;
    if (n.disabled) issues.push({ level: 'info', rule: 'disabled', node: n.name, message: `"${n.name}" is disabled: finish it by hand (see the report), then enable it.` });
    if (containsPlaceholder(n.parameters)) issues.push({ level: 'warning', rule: 'placeholder', node: n.name, message: `"${n.name}" still has a ${PLACEHOLDER} value to fill in.` });
    for (const [type, cred] of Object.entries((n.credentials ?? {}) as Record<string, any>)) {
      if (!cred?.id) issues.push({ level: 'warning', rule: 'credentials', node: n.name, message: `"${n.name}" needs a ${type} credential selected in n8n.` });
    }
  }
  if (!nodes.some((n) => isTrigger(String(n.type)) && !n.disabled)) {
    issues.push({ level: 'info', rule: 'trigger', message: 'No trigger: the workflow runs only when started by hand or from another workflow.' });
  }
  return issues;
}
