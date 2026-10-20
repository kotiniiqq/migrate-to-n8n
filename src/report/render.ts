/** The conversion report as Markdown: for the chat, the CLI and the .report.md file next to the workflow. */
import type { ConversionReport, Status } from '../types.ts';

const SOURCE = { make: 'Make', zapier: 'Zapier' } as const;
const BADGE: Record<Status, string> = { converted: '✅ converted', review: '⚠️ review', manual: '🛠 manual' };

/** Safe inside a Markdown table cell or heading. */
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');

export function totalsLine(r: ConversionReport): string {
  return `✅ ${r.totals.converted} converted · ⚠️ ${r.totals.review} to review · 🛠 ${r.totals.manual} manual`;
}

export function renderMarkdown(r: ConversionReport): string {
  const out: string[] = [`# ${SOURCE[r.source]} → n8n: ${cell(r.workflowName)}`, '', totalsLine(r), ''];

  out.push('## Next steps', '', ...r.nextSteps.map((s, i) => `${i + 1}. ${s}`), '');

  if (r.credentials.length) {
    out.push('## Credentials to reconnect', '', 'Credentials never leave Make or Zapier: create them in n8n and pick them in these nodes.', '');
    out.push('| App | n8n credential | Nodes |', '|---|---|---|');
    for (const c of r.credentials) out.push(`| ${cell(c.app)} | \`${c.credentialType}\` | ${cell(c.nodes.join(', '))} |`);
    out.push('');
  }

  if (r.webhooks.length) {
    out.push('## Webhook URLs that changed', '', 'The URL is your n8n address followed by the path below; n8n shows both test and production URLs in the node.', '');
    for (const w of r.webhooks) out.push(`- **${cell(w.node)}**: \`/webhook/${w.path}\``);
    out.push('');
  }

  out.push('## Steps', '', `| # | ${SOURCE[r.source]} step | n8n node | Status | What to check |`, '|---|---|---|---|---|');
  r.steps.forEach((s, i) => {
    const what = s.status === 'manual' ? [s.suggestion ?? '', ...s.notes] : s.notes;
    out.push(`| ${i + 1} | ${cell(s.sourceLabel)} (\`${cell(s.sourceKey)}\`) | ${cell(s.n8nNodes.join(' → '))} | ${BADGE[s.status]} | ${cell(what.filter(Boolean).join(' ')) || '—'} |`);
  });
  out.push('');

  if (r.placeholders.length) {
    out.push('## Placeholders to fill', '');
    for (const p of r.placeholders) out.push(`- **${cell(p.node)}** → \`${p.field}\`: \`${p.value}\``);
    out.push('');
  }
  return out.join('\n');
}
