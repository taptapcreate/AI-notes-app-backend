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

A validated review with no effective edits returns its reservation, including
identical replacements. The normal transaction releases wallet credits or Pro
allowance (including monthly ledger reservations), checkpoints recovery state,
and records an idempotent `unchanged` result with HTTP 200. This state is excluded
from successful-generation usage reconstruction. The receipt has zero costs,
`charged: false`, and `noChargeReason: "unchanged-writing-review"`. Replaying the
same request returns its result without another charge or refund. Useful edits
still use the displayed price; malformed results retain the existing refund path.
Older clients without policy 2 retain their original receipt contract.

No manual database migration or account edit is required. No previous completed
charges are retroactively changed. Tests use isolated databases and simulated AI;
live provider prose quality remains a separate check. No deployment was performed
by these source changes.


## Phase 2 editorial refinement

`services/writing-review.js` refines the Grammar, Improve and Revise prompts. Multi-batch chapter revisions receive bounded original-source chapter excerpts and neighbouring prose, built only from the approved chapter. These fields are read-only: result validation still accepts only editable batch segment IDs. There is no planning/summary API call, model change, charge change or relaxation of content-integrity validation. Additional input context increases provider input tokens; exact cost and prose quality require live measurement. Prompts are part of the existing checkpoint fingerprint.

`services/book-suggestions.js` prioritizes selection-sized Alternatives over the legacy page preference, asks for meaningful diversity, protects paragraph boundaries during expansion, and clarifies continuation length and placement. The version-1 request and pricing contracts remain compatible. The new desktop hides Alternatives length controls and normalizes new requests to selection-sized output. Existing saved receipts remain unchanged.

Validation: 284 backend tests passed using isolated databases and mocked providers. Added checks cover original-source context bounds, unchanged edit coverage, refusal of context-only IDs, exclusion of unapproved client-supplied context, and no extra planning calls. No live editorial result is claimed. The local provider key returned 401 on a read-only check; the installed app connected to Render but Book Studio AI required Pro. No paid generation, push or deployment was performed. Live-test authorization is below ₹100 total and remains pending access and deployment of the new prompts.
