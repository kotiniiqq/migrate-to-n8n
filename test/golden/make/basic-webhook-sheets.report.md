# Make → n8n: Leads from the website form

✅ 2 converted · ⚠️ 1 to review · 🛠 1 manual

## Next steps

1. Point the senders to the new webhook URL: "Form submitted" (…/webhook/leads-from-the-website-form).
2. Finish 1 step by hand: it is disabled and marked ⚠, with a suggestion next to it.
3. Check 1 step marked "review".
4. Run the workflow once with test data, then activate (publish) it.

## Webhook URLs that changed

The URL is your n8n address followed by the path below; n8n shows both test and production URLs in the node.

- **Form submitted**: `/webhook/leads-from-the-website-form`

## Steps

| # | Make step | n8n node | Status | What to check |
|---|---|---|---|---|
| 1 | Form submitted (`gateway:CustomWebHook`) | Form submitted | ✅ converted | The webhook gets a new URL in n8n: point the sender (form, app) to it. Make accepted GET and POST; this listens to POST. |
| 2 | Set variable (`util:SetVariable2`) | Set variable | ✅ converted | — |
| 3 | Google Sheets: Add Row (`google-sheets:addRow`) | Google Sheets: Add Row | 🛠 manual | Use the Google Sheets node (placed here, disabled): choose the operation closest to "Add row", connect the credential, map the fields, then enable it. Fields from Make: mode ← select; spreadsheetId ← /1AbCdEfGhIjKlMnOpQrStUvWxYz; sheetId ← Leads; includesHeaders ← true; insertDataOption ← INSERT_ROWS; valueInputOption ← USER_ENTERED; values ← {"0":"={{ $('Set variable').item.json.fullName }}","1":"={{ $('Form submitted').item.json.body.email }}","2":"={{ $no…. |
| 4 | Webhook response (`gateway:WebhookRespond`) | Webhook response | ⚠️ review | Uses data from "Google Sheets: Add Row", which must be finished by hand first. |
