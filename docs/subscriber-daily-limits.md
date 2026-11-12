# Subscriber daily limits

Set the default in the `ai_notes_app.appconfigs` document with `key: "master_config"` using `subscriberDailyLimit`. The public plan description uses this global value.

To give a specific subscriber a different limit, update their document in `ai_notes_app.users`:

```javascript
db.getSiblingDB("ai_notes_app").users.updateOne(
  { recoveryCode: "USER_RECOVERY_CODE" },
  { $set: { subscriberDailyLimitOverride: 20 } }
)
```

The override must be a whole number from 1 to 10,000. To inherit the global limit again:

```javascript
db.getSiblingDB("ai_notes_app").users.updateOne(
  { recoveryCode: "USER_RECOVERY_CODE" },
  { $unset: { subscriberDailyLimitOverride: "" } }
)
```

The server tracks usage per recovery account in `dailyRequestCount` and `lastRequestReset`. The allowance resets at midnight UTC. Changing a limit takes effect on the next balance or generation request and keeps usage already recorded for the day. An override does not grant Pro access. Devices linked to the same recovery account share the same allowance.
