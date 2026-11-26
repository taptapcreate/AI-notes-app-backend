# Writing review policy 2

Updated desktop clients request `writingReviewVersion: 1` and
`writingReviewPolicyVersion: 2`. `/api/config` advertises both. Deploy `server.js`,
`services/writing-review.js`, `services/generation.js`, and
`models/GenerationRequest.js` together before distributing the updated desktop.
The desktop checks capability before generation; an older server cannot charge
these reviews under its previous no-change policy.

Grammar review makes minimal useful corrections while preserving meaning, facts,
expressive description, emphasis, voice and formatting boundaries. Improve Writing
handles broader phrasing, rhythm and flow. Neither task should manufacture edits
when the wording is already effective.

A successful fresh review consumes its advertised credits even when no effective edits are suggested. Reopening a compatible saved result or retrieving a completed content-cache hit performs no generation and costs nothing extra. Explicit regeneration bypasses the completed-result cache and is billable on success. Duplicate transport requests replay the same receipt. Failed, invalid or incomplete reviews retain their full-refund path. Legacy `unchanged` receipts remain replayable; the current generation middleware does not create fresh zero-cost unchanged analyses.

No manual database migration or account edit is required. No previous completed
charges are retroactively changed. Tests use isolated databases and simulated AI;
live provider prose quality remains a separate check. No deployment was performed
by these source changes.


## Phase 2 editorial refinement

`services/writing-review.js` refines the Grammar, Improve and Revise prompts. Multi-batch chapter revisions receive bounded original-source chapter excerpts and neighbouring prose, built only from the approved chapter. These fields are read-only: result validation still accepts only editable batch segment IDs. There is no planning/summary API call, model change, charge change or relaxation of content-integrity validation. Additional input context increases provider input tokens; exact cost and prose quality require live measurement. Prompts are part of the existing checkpoint fingerprint.

`services/book-suggestions.js` prioritizes selection-sized Alternatives over the legacy page preference, asks for meaningful diversity, protects paragraph boundaries during expansion, and clarifies continuation length and placement. The version-1 request and pricing contracts remain compatible. The new desktop hides Alternatives length controls and normalizes new requests to selection-sized output. Existing saved receipts remain unchanged.

Validation: 284 backend tests passed using isolated databases and mocked providers. Added checks cover original-source context bounds, unchanged edit coverage, refusal of context-only IDs, exclusion of unapproved client-supplied context, and no extra planning calls. No live editorial result is claimed. The local provider key returned 401 on a read-only check; the installed app connected to Render but Book Studio AI required Pro. No paid generation, push or deployment was performed. Live-test authorization is below ₹100 total and remains pending access and deployment of the new prompts.

## Coordinated integrity stabilization — 26 November 2026

The Grammar prompt is unchanged. Shared backend/desktop validators retain source IDs, newline, omission, duplication and exact-range safeguards. They additionally protect the leading words of a split continuation (including honorific boundaries) and permit legitimate coreference rewrites without treating low token overlap alone as proof of shifted content. These are conservative deterministic guards, not a semantic-equivalence guarantee.

Batch validation keeps selected-page numbers, including gaps. Grammar and Improve receive only bounded neighboring selected prose at batch boundaries; no unselected page is added. Revision receives coherent bounded source windows instead of a few characters from each of hundreds of segments. Source segment order and formatting remain fixed; this does not implement arbitrary chapter restructuring.

After bounded validation retry, affected spans may receive one repair request. Unaffected proposed edits are retained only if the entire reconstructed batch validates with the repair. No unsafe proposals are silently dropped into a success result. Unrecoverable reviews still fail and refund in full. Final cross-batch failures clear only affected chunks; independently validated chunks remain reusable. Stale saved chunks are revalidated and repaired individually.

The `book-integrity-v3` fingerprint includes model, prompts and source/context. Completed-result caching now includes the same compatibility policy, model and generated prompts. Older records are not indiscriminately deleted. Exact request-ID idempotency remains authoritative. `/api/health` exposes the review compatibility value for deployment verification.

The existing four-attempt provider budget is retained per chunk within a 15-minute window, separately from 24-hour completed-chunk retention. Restarting or changing request IDs does not bypass it. A blocked attempt does not extend the original window. Expired ownership is reported as `BOOK_REVIEW_LEASE_LOST`, rather than retry exhaustion. Budget errors include remaining retry seconds. Missing counters are normalized when a checkpoint is acquired.

Book cooldowns distinguish operation and content. Zero-provider checkpoint/lease refusals cannot trip provider outage or account expenditure protection. Five genuinely costly failed operations still activate account protection, including validation failures with recorded provider calls; genuine provider failures retain the broader circuit. No credit prices, allowances or model are changed.

Deploy the canonical backend first, then distribute the matching desktop build. The desktop preserves page/mode metadata through parsing and apply, keeps dependent edits linked, and displays authoritative no-charge/refund receipts where supplied. The backend supplies a zero-cost receipt for recognized restrictions rejected before reservation; unknown reconciliation remains unknown.

Provider usage may increase slightly from bounded adjacent input context and, only after failed validation, the targeted repair call. Recovery reuses compatible completed work. No new paid verifier call is added to ordinary successful reviews. Mocked tests establish safeguards and accounting, not live editorial accuracy. No production database access, provider requests or deployment are part of this change.
