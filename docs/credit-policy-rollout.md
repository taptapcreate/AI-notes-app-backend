# One-time seven-credit allowance

The active allowance is shared by recovery-code account across mobile and desktop.
The backend grants seven free credits once, only when daily mode is disabled.
Existing production configuration is preserved until the explicit policy switch.

## Behavior

- New accounts receive seven free credits once. The server ignores client amounts
  and versions on `/api/credits/sync-welcome-pack`.
- Legacy daily accounts receive a single seven-credit welcome grant on their next
  balance, recovery, registration, or use request after switching to one-time mode.
- A prior `welcomePackVersion > 0`, a remaining `totalFreeCredits > 0`, or the new
  `welcomeGrantClaimedAt` marker means the account already received its pack.
  The existing remaining amount is preserved, including zero or more than seven.
- Once claimed, neither another day nor a welcome-version increase replenishes it.
- Purchased and ad balances remain intact. Spending consumes free, ad, then paid.
- Recovery never deletes the account being switched away from. Repeated concurrent
  registrations with the same provided device identity use one registration record.
- Every credit response uses the active free-credit pool. Existing mobile fields
  (`freeCreditsRemaining`, `remainingFreeCredits`, `version`, `newBalance`, etc.) remain.
- Missing or invalid configuration fails the request instead of granting fallback credits.

## Purchase fixes included

`/api/credits/add` retains the mobile request format, including synthetic transaction
IDs. Those IDs and the client `credits` value cannot authorize a grant. The endpoint
syncs purchases verified using the server's RevenueCat secret API key and uses a
server product-to-credit mapping. A repeated call returns the actual paid balance.

Verified transaction aliases are reserved to one account, then credited with an
atomic conditional update. Interrupted requests can finish on retry. Duplicate
webhooks, purchase syncs, and support linking cannot grant the same transaction
again. Support linking and purchase inspection now require a distinct admin secret.
RevenueCat TEST events do not grant credits. Production ignores sandbox purchases
unless the explicit sandbox option is enabled in an isolated environment.

## Deploy and switch

The user is handling the backend push/deployment. Push all changed and new files,
including `models`, `services`, `routes`, `scripts`, the lockfile and tests.

1. Run `npm ci` and `npm test` with Node 22. Tests use an isolated MongoDB server and
   replica set; they do not contact production, AI providers or real payment APIs.
2. Confirm the deployed environment has real `REVENUECAT_API_SECRET_KEY`,
   `REVENUECAT_WEBHOOK_SECRET` and `OPEN_ROUTER_API_KEY` values.
   `ADMIN_API_SECRET` is additionally required for support purchase linking.
   Set `TRUST_PROXY_HOPS` to the deployment's verified proxy depth. Multi-instance
   rate limiting requires a shared rate-limit store.
3. Push/deploy the backend. Check `/api/health` and `/api/config`:
   `creditPolicyVersion` must be `one-time-v1`, and `generationBillingVersion` must
   be `2`. Keep `generationBillingRequired` false during the staged rollout.
   Existing production daily-credit settings are preserved by this deployment.
   Existing mobile versions keep their legacy generation/deduction flow during
   this period; new clients already use server billing.
4. Test real RevenueCat entitlements and product IDs in a staging database. MongoDB
   must support multi-document transactions (a replica set or sharded cluster;
   Atlas supports these). A missing verification key blocks authenticated AI
   generation rather than silently spending a subscriber's paid/free credits.
5. Release mobile version **1.0.2** (iOS build **7**, Android version code **12**),
   or a newer build containing these client changes. Signed build artifacts are
   separate from App Store / Google Play submission and store approval. Expo SDK
   54 `expo-crypto` is a native dependency, so use new native builds rather than
   an OTA JavaScript update of an older binary.
6. Use the updated desktop preview from `desktop/release-credits/mac-arm64/AI Notes.app`.
   The previous preview remains in `desktop/release`; it uses the legacy protocol
   and will need replacing before strict cutover.
7. **After the updated clients are available**, run in the backend environment:

   ```sh
   npm run credits:policy -- --dry-run
   npm run credits:policy -- --apply --clients-ready
   ```

   Apply first checks that the deployed backend advertises billing protocol 2 and
   requires the explicit clients-ready acknowledgement. Set `CREDIT_POLICY_API_URL`
   only when targeting a different backend (default is the existing production
   `/api` URL). Then it privately backs up the current config and atomically sets:

   ```json
   {
     "dailyFreeCreditsEnabled": false,
     "welcomePackCredits": 7,
     "generationBillingRequired": true
   }
   ```

   The welcome amount above is an example. The script preserves the current
   `master_config.welcomePackCredits` value instead of replacing it with seven.
   Missing legacy values default to seven; zero is allowed.

   `welcomePackVersion`, purchased/ad balances, and existing welcome balances stay
   intact. The script never bulk-resets user balances. Keep the config backup
   outside an ephemeral Render filesystem if operational history is needed.
8. Confirm those three flags through `/api/config`. Test a dedicated account's
   generation, exhaustion, recovery, interruption/retry, and subscription quota.
   Older mobile versions will receive an update-required error after this cutover.

## Generation protocol 2

Every updated client sends `Authorization: Bearer <recovery code>` and a UUID v4
`Idempotency-Key` header on each AI request. The recovery code is a secret credential. Generation uses headers; avoid logging
credentials or storing them in renderer-managed preferences. Legacy balance clients
still use the existing code-in-path endpoint, so redact those paths from access logs.
The server ignores the client `isPro` flag and verifies current RevenueCat
subscription entitlements, including valid billing grace periods and known products.

A MongoDB transaction reserves a free/ad/paid credit (or a subscription daily slot)
and records the request identity together. Success commits a cached result and a
billing receipt. Errors, invalid/empty results, and timeouts return the reservation
exactly once. Expired pending reservations are recovered after process restart and
by a background sweep. Provider requests are aborted locally on timeout and no new
provider retry begins after expiry. Provider-side processing may still incur usage.

Completed results return `billing.version: 2`, the original request ID, the actual
balance, and verified subscription information. Clients use this receipt and never
call `/credits/use` after generation. The mobile simulated-typing view still uses
normal JSON generation; the old unmetered SSE endpoint is disabled.

Clients persist only request hashes and IDs when results are interrupted. Retrying
the same content/account reuses the ID; other pending content retains its own ID.
Successful or confirmed-failed requests clear that pending identity. The server
retains generated result content for up to 24 hours for recovery, then purges the
content while keeping a small idempotency record. A late retry of a purged result
returns HTTP 410 and cannot silently charge the same request again. Raw source
content is not stored in the billing ledger.

Mobile now displays only confirmed server balances. Older caches that could contain
locally replenished credits are not reused. It no longer grants credits offline,
resets free credits at midnight, or performs a second post-generation deduction.
Recovery preserves saved identity if the backend cannot find the account. RevenueCat
login is serialized and bound to the current recovery account before generation.

## Operational boundaries

Device identities remain client supplied; duplicate-registration protection is not
proof of a person or physical device. Anonymous legacy registration stays compatible;
stronger anti-abuse needs verified identity or platform attestation. Recovery codes
are bearer secrets; do not share them. This migration does not rotate existing codes.

Historical purchases recorded under synthetic client IDs alone cannot be matched to
store transactions without payment-provider records. Reconcile those records before
rollout if relevant. Verified legacy RevenueCat IDs learn additional aliases without
another grant; historical duplicates/refunds are not automatically reversed.

Do not roll back to the old vulnerable credit handlers after strict cutover. Restoring
an earlier daily-mode config intentionally resumes daily grants. Existing one-time
claims still stay spent if this code later switches back to one-time mode.

References: [MongoDB transactions](https://mongoosejs.com/docs/transactions.html),
[RevenueCat customer data](https://www.revenuecat.com/docs/api-v1/customer-info-model),
[RevenueCat webhook fields](https://www.revenuecat.com/docs/integrations/webhooks/event-types-and-fields).


## Database-managed welcome allowance

After deploying the configurable-credit backend, edit `ai_notes_app.appconfigs`,
document `{ key: "master_config" }`, field `welcomePackCredits`. Supported values
are whole numbers from 0 to 10000; zero disables the initial free grant. Seven is
only the default when the field is missing. The public config also reports `welcomeCreditsConfigurable: true`; the cutover
script requires this capability before applying settings. The configured amount is read on each
request and is returned by `/api/config` and credit balance responses, so later
changes do not require another deployment or server restart.

This setting controls future one-time grants when `dailyFreeCreditsEnabled` is
false. The daily compatibility policy remains controlled separately by
`dailyFreeCreditsEnabled` and `freeDailyCredits`. Follow the release sequence above
before switching production out of daily mode. Verify the stored welcome amount
before the switch; an existing database value now takes effect as written.

Changing the amount does not reset existing remaining credits, remove purchased
or ad credits, or re-grant a spent allowance. A user granted zero is still marked
as having claimed the allowance, so increasing the global setting later does not
refill that account. Do not clear claim markers to reset balances. Bulk balance
changes are a separate operation and were not performed by this update.

Invalid stored amounts fail with a configuration error instead of silently granting
seven. The schema also validates amounts written through the Mongoose model.

Validation: 50 isolated MongoDB/API tests pass. Tests change the configuration while
the same server process runs and verify new grants, zero grants, existing balances,
invalid values, concurrency and preservation of the selected amount during cutover.
No production database values or deployment were changed by this code update.


## Shared subscription allowance and purchased credits

The default subscription allowance is 10 successful generations per account per UTC day. Existing databases keep their configured value until changed. Daily usage is shared across devices connected to the same recovery code. The balance endpoint returns the remaining allowance and the server's next reset timestamp. Explicit `billingMode: "purchased"` requests spend one purchased credit, preserve Pro access, and do not consume the daily allowance. Provider failures refund the reserved credit or daily slot.

Deploy the updated backend and updated clients, then set the existing configuration to 10 using the database's `master_config.subscriberDailyLimit` field or run on a machine with the production `MONGODB_URI` configured:

```sh
node scripts/subscription-policy.js --dry-run
node scripts/subscription-policy.js --apply
```

This changes only the limit. It preserves purchased balances, existing usage, welcome grants, and accounts. Users already over the new limit regain their daily allowance at the next UTC midnight. The public config reports `subscriptionUsageVersion: 1` and `purchasedCreditFallback: true` when the updated backend is deployed.


## Mandatory mobile update and November policy check

The public configuration checked on 2026-11-12 still had
`dailyFreeCreditsEnabled: true`, `freeDailyCredits: 2`, `welcomePackCredits: 8`,
`generationBillingRequired: false`, and `subscriberDailyLimit: 10`.
Deploying code does not overwrite an existing `master_config` document.
The `creditPolicyVersion` capability flag alone does not mean daily grants are off.

`/api/config` now returns both the existing flat fields and `ios`/`android` objects
with `minVersion`, `latestVersion`, `forceUpdate`, `forceLatest`, `storeUrl`, and
`releaseNotes`. This also supplies the field names expected by the existing update
modal. Installed binaries that do not contain that modal cannot gain it just from
this backend update; strict server billing still rejects their old unauthenticated
AI requests after cutover. A popup is a UI prompt, not the enforcement boundary.

Prepare each platform separately. Only require a version that is publicly available
to that platform's users (including any staged rollout). For example, after iOS
1.0.4 is available, the existing `ai_notes_app.appconfigs` master document can use:

```js
// Run against ai_notes_app, after confirming the iOS update is live.
db.appconfigs.updateOne({ key: "master_config" }, { $set: {
  "ios.minVersion": "1.0.4",
  "ios.latestVersion": "1.0.4",
  "ios.forceUpdate": true,
  "ios.storeUrl": "https://apps.apple.com/app/id6757496314",
  "ios.releaseNotes": [
    "Updated one-time free credits and clear daily Pro usage.",
    "Improved notes, replies, and native iPhone/iPad tools."
  ]
} });
```

Leave Android's minimum at its current supported release until the new Android
version is available, then set `android.minVersion`, `android.latestVersion`,
`android.forceUpdate: true`, and
`android.storeUrl: "https://play.google.com/store/apps/details?id=com.taptapcreate.ainotes"`.
Use the actual public version. Do not advance global `minAppVersion` to an iOS-only
release, because it is the fallback for both platforms. New mobile clients check
updates on launch and foreground, keep an existing mandatory prompt on a network
failure, and handle store-opening failures without dismissing the prompt.

To choose seven one-time credits for future eligible accounts, change
`welcomePackCredits` to `7` in that master document. This does not replace existing
claimed balances or give everyone another seven credits. Existing daily-only users
who never claimed a welcome pack receive the configured one-time allowance when
first synchronized after cutover; existing claimed/spent packs are preserved.

After updated clients are available and the mandatory update is configured,
run the documented `credits:policy -- --dry-run`, then
`credits:policy -- --apply --clients-ready` from the backend environment.
This disables daily grants and requires authenticated server billing together.
Keep `subscriberDailyLimit: 10`. A subscription supplies ten *generations* per UTC
day per connected AI Notes account, not ten transferable wallet credits; reset is
00:00 UTC (05:30 in India). At the limit, updated apps offer waiting for reset or,
only with explicit consent, spending a purchased credit. Failure and retry billing
follow the idempotent generation protocol.

Confirm the actual flags in `/api/config` after the switch. No live configuration
was changed by the mandatory-update source fix. Android and iOS share this policy,
so switching strict billing before Android is updated will block its legacy AI
requests too, even if its update message has not appeared.
