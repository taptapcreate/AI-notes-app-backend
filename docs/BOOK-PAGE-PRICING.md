# Book page reviews and revision pricing

The desktop sends prose-only `writingReviewVersion: 1`, `writingReviewPolicyVersion: 2`, `bookPageBillingVersion: 1` requests to `/api/followup`. `bookPageQuote` must equal the number of text-page groups in context. Every segment must be assigned exactly once; page numbers must be unique and increasing. Image-only and empty pages are excluded by the editor. The backend validates the quote and reserves one unit per mapped page. This feature requires Pro.

Long requests are processed in bounded prose batches. No partial result is returned or applied. Validation or provider failure releases the entire reservation. A review with no useful edits also releases the reservation. Idempotency prevents duplicate charges when replaying the same request. Saved-result review/application requires no AI call.

Deploy this backend before distributing the updated desktop. `/api/config` advertises `bookPageBillingVersion: 1`; desktop preflight blocks page requests against older servers before payment. New chapter draft and suggestion pricing remains unchanged. No database migration or production settings change is needed for this pricing feature.

Mac update notes are stored in `appconfigs` / `master_config` / `macos.releaseNotes` as short strings (up to 10 displayed; 500 characters each). Set `macos.forceUpdate` false and retain a supported `macos.minVersion` for optional updates; a minimum above the installed version remains mandatory. The updated desktop offers a persistent Skip this version for optional releases.
