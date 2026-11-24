# Writing review policy 2

Updated desktop clients request `writingReviewVersion: 1` and
`writingReviewPolicyVersion: 2`. `/api/config` advertises both. Deploy `server.js`,
`services/writing-review.js`, `services/generation.js`, and
`models/GenerationRequest.js` together before distributing the updated desktop.
The desktop checks capability before generation; an older server cannot charge
these reviews under its previous no-change policy.

Grammar review now also looks for useful phrasing and flow improvements in
otherwise grammatical prose, preserving meaning, facts, voice, and formatting
boundaries. It must not manufacture edits when the wording is already effective.

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
