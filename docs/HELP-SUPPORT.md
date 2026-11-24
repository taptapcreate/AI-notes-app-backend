# Help & FAQ support card

The desktop reads `helpSupport` from `/api/config`. Its database source is the
`master_config` document in the `appconfigs` collection of `ai_notes_app`.

```json
{
  "helpSupport": {
    "enabled": false,
    "title": "More help",
    "message": "Need help with a feature, purchase, or technical issue? You can send us a query through our support website.",
    "buttonLabel": "Visit support website",
    "url": ""
  }
}
```

Set `enabled` to the Boolean `false` to hide the whole card, or `true` to show it.
All copy and the URL are editable. Set `url` to your real HTTPS support website
when ready; an empty or invalid URL keeps the whole card hidden, even if enabled is true.
The link opens in the user's browser. No notes, recovery code, billing details,
or other app data are appended to the URL or automatically submitted.

The backend seeds missing fields on startup, preserving existing values,
especially a Boolean false. Initialize an existing deployment explicitly with
`node scripts/help-support.js --apply --disable`; without `--apply` the command is
read-only. This touches only these support fields. It does not alter billing,
accounts, notes, credentials or other settings.

The desktop refreshes configuration on focus and every 30 seconds while visible.
After deploying this backend and a desktop version with the card, future database
edits to the card do not require another app build. An older server response with
no support settings leaves the card hidden. The support site itself is external;
this feature does not create tickets or promise a response time or refund.
