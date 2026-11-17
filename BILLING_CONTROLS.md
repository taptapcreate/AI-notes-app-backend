# Purchase visibility controls

In `ai_notes_app.appconfigs`, the document with `key: "master_config"` supports:

```json
{
  "billingControls": {
    "showSubscriptions": true,
    "showTopUpPacks": true,
    "usePrimarySubscriptionTracking": true
  },
  "platformBillingControls": {
    "ios": { "showSubscriptions": true, "showTopUpPacks": true },
    "android": { "showSubscriptions": true, "showTopUpPacks": true },
    "macos": { "showSubscriptions": true, "showTopUpPacks": true },
    "windows": { "showSubscriptions": true, "showTopUpPacks": true }
  }
}
```

The global purchase flag AND the platform purchase flag must permit a category. Missing flags default to true. A global false disables that category everywhere, including when a platform says true. Set only `platformBillingControls.windows.showSubscriptions` to false to hide subscription offers on Windows while leaving top-ups and other platforms unchanged.

These are offer-visibility controls, not entitlement revocation. Restore and manage existing subscriptions remain available. Allowance tracking remains global because subscribers share their quota across devices. The flags do not implement a Windows payment provider.

Clients refresh configuration while active and cache effective controls for startup. Existing installed builds understand only the fields shipped in that build; per-platform controls require a new mobile/desktop build. Global controls continue to work for previous builds that already support them.

Run `node scripts/billing-controls.js --dry-run` to inspect missing fields, then `--apply` to seed only absent fields. Existing values are preserved. Deploy the backend schema before saving these fields through Mongoose. Updated clients support missing platform fields safely.

## Subscription rollover

`master_config.subscriptionRollover.monthlyEnabled` defaults to `false`. The supported value for `maxCarryPeriods` is `1`. The accounting models store the verified subscription's original grant, usage, and billing dates separately from purchased and lifetime credits. Weekly and trial allocations are ineligible for rollover.

Phase 1 introduces the config and accounting primitives. Renewal and request handlers continue using the existing balance system. Wait for the renewal and reconciliation implementation before enabling this setting.
