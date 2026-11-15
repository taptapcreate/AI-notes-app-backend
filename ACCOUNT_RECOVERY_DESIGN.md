# Transactional account recovery

The existing `users` and `applesubscriptions` collections remain the working records. `accountrecoveries` holds separate server-confirmed snapshots. No model collection is renamed or replaced.

## Protected operations

Credit registration and starter grants, legacy welcome migration, daily resets, purchased credits and transaction aliases, ad rewards, legacy credit deductions, generation reservations and refunds, wallet subscription links, StoreKit verification, Apple quota counters, and expiration/refund webhooks checkpoint in the same MongoDB transaction as their working-record changes.

Restoration preserves original MongoDB IDs, recovery codes, device IDs, remaining purchased/free/ad balances, grant and reset dates, purchase history and aliases, Apple subscription links, quota epochs and verified expiration/revocation state. The app's local cache never authorizes a restored balance. Different Apple sandbox subscriptions retain separate identities and quotas.

Deleting a working record or collection does not erase its saved snapshot. A balance request, device re-registration, verified StoreKit update or generation refund can restore it. Repeated recovery cannot issue another starter grant or credit a processed purchase twice. Unknown accounts without a trusted snapshot fail closed; existing deliberate-deletion markers block resurrection. Deleting both the working record and its recovery record still requires an Atlas backup.

## Initial production cutover

1. Stop all old backend writers during the initial deployment. A previous release cannot update the new snapshots.
2. Deploy the complete updated backend. Startup runs an idempotent initial backup of existing wallet/subscription records; it does not modify balances or issue grants. Credits and generation return 503 until all snapshots are ready. Config remains readable.
3. Check `/api/config` for `accountRecoveryVersion: 1`. This indicates the initial backup completed successfully. The completion marker and counts are stored in `accountrecoverycutovers` with key `transactional-recovery-v1`.
4. Keep `accountrecoveries`, `accountrecoverycutovers`, `creditregistrations`, `purchaseclaims` and the working collections included in Atlas backups. Do not remove the snapshots during a deletion-recovery test.

For operator-controlled preparation, `node scripts/account-recovery.js --dry-run` reports record counts without changing data. `node scripts/account-recovery.js --apply --writers-stopped` performs the same initial backup. `MONGODB_URI` is required. The completed cutover is skipped on later starts; new records and every credit mutation continue to receive transactional checkpoints.

If startup fails, financial operations remain unavailable and the server logs the cause. Partial initial snapshots are safe to retry. Do not deploy old writers after this cutover: they would allow snapshots to become stale. Already-missing predeployment records cannot be reconstructed without an earlier trustworthy backup.

## Test procedure

Use a sandbox account. Note its remaining balances, original code and today's allowance. Complete a generation or spend some credits, then delete only its `users` document. Reopen or refresh: the same code and unspent balances should return. Deleting the corresponding `applesubscriptions` record should preserve the same quota epoch and remaining allowance. Replaying a verified purchase or failed generation must not add credits twice.

## Announcements

`globalAlert` supports `displayMode: "banner"` or `"popup"`, optional `id`, `active`, `title`, `message` and existing `isBlocking`. Routine announcements should use a dismissible banner. Changing id/message shows a new campaign. Announcement text does not grant credits.
