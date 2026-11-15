# Maintenance and individual announcements

These controls require the updated backend and updated iOS/Android/macOS clients. Existing released apps do not gain new client behavior until updated. This change does not publish an announcement or enable maintenance.

## Maintenance: appconfigs → master_config → maintenance

On backend startup, missing controls are initialized and an empty `userannouncements` collection is created. Existing values are preserved, including a legacy active blocking alert. New platform controls default to false.

```json
{
  "enabled": false,
  "title": "We’ll be back soon",
  "message": "AI Notes is undergoing maintenance. Please try again shortly.",
  "platforms": {
    "ios": { "enabled": false, "title": "iOS maintenance", "message": "Please try again after 10 PM." },
    "android": { "enabled": false },
    "macos": { "enabled": false }
  }
}
```

Global `enabled: true` blocks all platforms and uses the global title/message. Otherwise a platform's `enabled: true` blocks only that platform; its missing title/message falls back to the global text. Global false does not cancel a platform true. Turn all applicable switches false to reopen the app.

The blocking screen has Check again, no dismiss action, and automatic refresh every 30 seconds while active or on foreground. Saved notes remain in place. A fresh process always starts with local maintenance false; cached true is never restored. Once the running app confirms true, temporary network failure retains that block until a successful false response. A cold launch without a connection cannot know the remote switch; the server still rejects generation during maintenance. Verified payment reconciliation, config polling, and operational recovery remain available.

New requests identify their platform using `X-App-Platform`. Legacy clients without that header are affected by global maintenance, not platform-specific controls. Global maintenance is also mirrored into the legacy blocking alert for older compatible clients.

## Individual messages: userannouncements

Insert one document per recovery code in the `ai_notes_app.userannouncements` collection. The recovery code should match the uppercase code in `users`. Example template (replace the code before inserting):

```json
{
  "recoveryCode": "TARGET_RECOVERY_CODE",
  "id": "account-message-2026-11-15-1",
  "active": false,
  "title": "A message from AI Notes",
  "message": "Your message here.",
  "displayMode": "banner",
  "platforms": [],
  "expiresAt": null
}
```

Set `active` true to display it. Use `displayMode: "popup"` for a dismissible popup or `"banner"` for a top banner on Home. Empty `platforms` means all supported platforms; use `["ios"]`, `["android"]`, or `["macos"]` to restrict delivery. `expiresAt` may be a BSON Date. For a new campaign, change `id`. Set active false or delete the message document to withdraw it on the next refresh.

Individual messages take priority over the existing `globalAlert`; maintenance takes priority over both. Dismissal is remembered per message and account. Messages are checked on account connection, foreground, and every 30 seconds. They are not push notifications, and they do not grant credits. Changing the recovery code cannot expose a previous account’s message.

The read endpoint is `GET /api/credits/announcement`, authenticated by the saved account's Bearer recovery code. It accepts no target code in the URL, returns only that account's message and a hashed account scope, and sends Cache-Control: no-store. It is not included in public `/config`. Keep recovery codes private; they are account credentials. There is intentionally no unauthenticated message-writing API.

## Validation

Backend tests cover account isolation, missing authentication, expiry/platform filtering, global/platform precedence, generation blocking before charging, and non-destructive initialization. Client tests cover message selection and account-scoped dismissal. Electron UI tests cover banners/popups, refresh/dismissal, non-dismissible maintenance, recovery after false, purchase blocking, and ignoring a stale cached true. The iOS JavaScript export compiles; this is not a new signed native release.
