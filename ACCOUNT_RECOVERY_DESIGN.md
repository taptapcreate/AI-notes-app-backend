# Prepared account recovery layer — not active in production

`accountrecoveries` stores complete server-side snapshots of wallet and Apple subscription records, including remaining balances, original MongoDB IDs, processed purchase aliases, subscription links, quota epochs, reset dates and verification state. Local app data never authorizes a restored balance.

The existing `users` and `applesubscriptions` model targets remain unchanged. No startup migration or automatic production recovery is enabled. The new service is exercised only by isolated tests until integration is approved.

`run(identity, operation)` restores a missing record from its confirmed snapshot, applies an operation, and checkpoints the resulting record in one MongoDB transaction. `ensure` and `checkpoint` support existing generation and Apple subscription transactions. Concurrent updates conflict and retry together, so a stale backup cannot restore spent credits. Unknown accounts without a trustworthy snapshot fail closed.

## Required integration before release

All registration grants, welcome migrations, daily resets, purchased credits and aliases, ad claims, legacy deductions, generation reservations/refunds, wallet subscription links, Apple proof updates/revocations and subscription daily counters must checkpoint in the same transaction. Backup all currently existing records during a controlled cutover with prior writers stopped; retain original IDs and values. The migration must not guess balances for already-missing records or replace newer snapshots. Device registration must check backup recovery before issuing a new starter allowance. Existing deletion markers must block restoration of deliberately erased accounts.

Do not enable partially: an uncheckpointed credit-changing path can make recovery stale. Tests currently validate the transaction/restore primitive, not a deployed integration. Deleting both the live record and its recovery snapshot still requires a database backup.

## Announcement configuration

`globalAlert` supports `displayMode: "banner"` or `"popup"` (default preserves existing popup behavior), `id`, `active`, `title`, `message` and the existing `isBlocking`. Routine announcements should use a dismissible banner. Changing id/message shows a new campaign. Announcement text does not grant credits.
