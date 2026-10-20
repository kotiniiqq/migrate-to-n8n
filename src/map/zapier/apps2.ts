/** Zapier: other spellings of built-in apps, new-row triggers, Tables lookup, Zapier Mail, Interfaces forms, Linear. */
import { randomUUID } from 'node:crypto';

import { findEntry, n8nNode, register } from '../registry.ts';
import { appRef, rl, str } from '../shared.ts';

/** Same mapping under another key (Zapier renames apps and actions over time). */
function alias(key: string, target: string) {
  register({ source: 'zapier', key, label: findEntry('zapier', target)?.label ?? target, build: (ctx) => findEntry('zapier', target)!.build(ctx) });
}

alias('DelayAPI:delay_until', 'DelayCLIAPI:delay_until');
alias('DelayAPI:delay_for', 'DelayCLIAPI:delay_for');
alias('FilterCLIAPI:zapier_filter', 'FilterAPI:filter');
alias('FilterCLIAPI:filter', 'FilterAPI:filter');
alias('SlackCLIAPI:send_channel_message', 'SlackCLIAPI:channel_message');
alias('SlackAPI:send_channel_message', 'SlackAPI:channel_message');
alias('ZapierMailCLIAPI:outbound', 'EmailCLIAPI:outbound');

for (const api of ['GoogleSheetsV2CLIAPI', 'GoogleSheetsV2API']) {
  for (const action of ['new_row_notify_hook', 'new_row', 'new_or_updated_row', 'updated_row_notify_hook']) {
    register({
      source: 'zapier', key: `${api}:${action}`, label: 'Google Sheets Trigger',
      build(ctx) {
        const p = ctx.step.params;
        const sheet = str(p.worksheet);
        if (!p.spreadsheet) ctx.note('The export has no settings for this step (Zapier left them out): pick the spreadsheet and sheet in n8n.', true);
        return {
          nodes: [n8nNode('googleSheetsTrigger', ctx.step.label, {
            pollTimes: { item: [{ mode: 'everyMinute' }] }, documentId: rl('id', ctx.expr(str(p.spreadsheet))), sheetName: /^\d+$/.test(sheet) ? rl('id', sheet) : rl('name', ctx.expr(sheet)),
            event: /updated/.test(action) ? 'anyUpdate' : 'rowAdded', options: {},
          })],
          status: p.spreadsheet ? 'converted' : 'review', credential: { app: 'Google Sheets Trigger', credentialType: 'googleSheetsTriggerOAuth2Api' }, ref: appRef('Google Sheets Trigger'),
        };
      },
    });
  }
}

register({
  source: 'zapier', key: 'TableCLIAPI:find_record', label: 'Data Table: Get Rows',
  build(ctx) {
    const p = ctx.step.params;
    const keyName = str(p.field_data_key ?? p.lookup_field).replace(/^data__/, '') || 'id';
    ctx.note('Zapier Tables became an n8n Data Table (n8n ≥ 1.113): create the table with the same fields (Zapier calls them f1, f2…; rename to yours), then pick it here.', true);
    return {
      nodes: [n8nNode('dataTable', ctx.step.label, { resource: 'row', operation: 'get', dataTableId: rl('list', ''), matchType: 'allConditions', filters: { conditions: [{ keyName, condition: 'eq', keyValue: ctx.expr(str(p.lookup_value ?? p.value)) }] }, returnAll: false, limit: 1 })],
      status: 'review',
    };
  },
});

register({
  source: 'zapier', key: 'InterfacesCLIAPI:new_form_submission', label: 'n8n Form Trigger',
  build(ctx) {
    ctx.note('Zapier Interfaces hosted the form; n8n hosts one too (Form Trigger): add the same fields to it, then share its URL instead of the old form.', true);
    return { nodes: [n8nNode('formTrigger', ctx.step.label, { formTitle: ctx.step.label, formFields: { values: [] }, options: {} }, { webhookId: randomUUID() })], status: 'review', ref: appRef('Form Trigger') };
  },
});

register({
  source: 'zapier', key: 'LinearCLIAPI:create_issue', label: 'Linear: Create Issue',
  build(ctx) {
    const p = ctx.step.params;
    const extra: Record<string, unknown> = {};
    if (str(p.description)) extra.description = ctx.expr(str(p.description));
    ctx.note('Pick the Linear team in the node.', true);
    return {
      nodes: [n8nNode('linear', ctx.step.label, { resource: 'issue', operation: 'create', teamId: str(p.team_id ?? p.team), title: ctx.expr(str(p.title)), additionalFields: extra })],
      status: 'review', credential: { app: 'Linear', credentialType: 'linearApi' }, ref: appRef('Linear'),
    };
  },
});
