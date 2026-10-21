# Make → n8n: Leads from the website form

✅ 2 converted · ⚠️ 2 to review · 🛠 0 manual

## Next steps

1. Connect credentials in n8n for: Google Sheets.
2. Point the senders to the new webhook URL: "Form submitted" (…/webhook/leads-from-the-website-form-random).
3. Check 2 steps marked "review".
4. Set the time zone in the workflow settings to the one your Make account used: dates, times and schedules here follow it (without it n8n uses the instance default, often America/New_York).
5. Run the workflow once with test data, then activate (publish) it.

## Credentials to reconnect

Credentials never leave Make or Zapier: create them in n8n and pick them in these nodes.

| App | n8n credential | Nodes |
|---|---|---|
| Google Sheets | `googleSheetsOAuth2Api` | Google Sheets: Add Row |

## Webhook URLs that changed

The URL is your n8n address followed by the path below; n8n shows both test and production URLs in the node.

- **Form submitted**: `/webhook/leads-from-the-website-form-random`

## Steps

| # | Make step | n8n node | Status | What to check |
|---|---|---|---|---|
| 1 | Form submitted (`gateway:CustomWebHook`) | Form submitted | ✅ converted | The webhook gets a new URL in n8n: point the sender (form, app) to it. Make accepted GET and POST; this listens to POST. |
| 2 | Set variable (`util:SetVariable2`) | Set variable | ✅ converted | — |
| 3 | Google Sheets: Add Row (`google-sheets:addRow`) | Google Sheets: Add Row | ⚠️ review | Make wrote these columns by position (A, B, C…); n8n writes by column header: open the node, pick the sheet and map each value to its header. |
| 4 | Webhook response (`gateway:WebhookRespond`) | Webhook response | ⚠️ review | Check the fields read from "Google Sheets: Add Row": the n8n Google Sheets node may name them differently. Original: {"ok": true, "row": "{{3.tableName}}"} |
