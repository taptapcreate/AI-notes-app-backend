# Desktop AI processing disclosure

The desktop permission card reads `processingDisclosure` from the existing
`GET /api/config` response. The values live in the `appconfigs` collection's
`key: "master_config"` document. No account or document data is needed to edit
this configuration.

Example value (the defaults used when fields are absent):

```json
{
  "providers": ["OpenRouter", "OpenAI"],
  "cloudPdfProviders": ["Mistral"],
  "recoveryMessage": "Results are available for recovery for up to 24 hours.",
  "details": "Hosted on Render. Saved credentials are excluded. Nothing is posted back automatically."
}
```

In MongoDB's document editor, add or edit the `processingDisclosure` object on
that existing document. Preserve the other fields. This release does not modify
the live database or add an admin endpoint.

- `providers`: the recipients used for normal AI generation, up to five names,
  40 characters each.
- `cloudPdfProviders`: additional recipients shown only when cloud PDF pages are
  selected, with the same limits.
- `recoveryMessage`: one plain-text sentence, maximum 140 characters.
- `details`: optional disclosure shown under Privacy details, maximum 180
  characters.

Empty or invalid fields use safe defaults. The endpoint exposes only the four
normalized fields above for this object. The desktop also validates the values,
renders plain text, and rejects oversized copy. Recovery wording applies to our
recoverable results, not all provider-side retention.

Deploy the backend changes and distribute a desktop build containing this UI
before relying on the database fields. Subsequent copy/provider edits need no
desktop rebuild. The app refreshes settings on launch, focus, and every 30 seconds
while visible. Approval is tied to the displayed providers and copy; after a
change is received, users must approve again, including before regeneration.

These fields describe processing; they do not switch providers, change routing,
or change retention. Update them alongside the actual processing configuration
and the website privacy policy. Keep the recipients accurate for every enabled
processing path.
