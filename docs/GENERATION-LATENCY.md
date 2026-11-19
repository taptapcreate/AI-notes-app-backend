# Generation latency improvements

## Observations

Public production GET requests during this investigation returned health in 0.464 s and 0.325 s, and config in 0.809 s. These samples indicate a responsive server at that moment; they do not measure model time, authenticated credit checks or cold starts. No production AI calls or user credits were used to benchmark these changes.

The AI adapter already disables extra reasoning and streams note output where requested. This change retains the same model, output limits, retry policy, provider selection and billing rules.

## Changes

- A generation request now shares one configuration lookup across maintenance, reservation and subsequent policy/balance reads. The scope lasts for that one request; the next request reads fresh settings. Administrative and purchase/recovery routes retain their existing fresh reads. This avoids repeated database round trips without a cross-request policy cache.
- Desktop balance and membership reads run concurrently after Apple proof synchronization. Account switching remains serialized, unavailable membership remains unknown, and the server still authorizes and bills each generation.
- Structured desktop grammar/writing reviews use an editing prompt rather than the generic follow-up article template. This removes conflicting headings and requests only changed JSON segments. Ordinary follow-ups are unchanged.
- Provider completion logs report model, endpoint, completion duration, time to first streamed text, success and time before the model call. They do not log prompts, manuscript content, account codes or credentials. Timing callbacks cannot fail a completion.

## Reading timings

The `AI provider timing` server log separates `durationMs` (provider call), `firstTextMs` (first streamed text when available) and `beforeModelMs` (authenticated middleware and source preparation before that attempt). It excludes desktop account checks, maintenance before billing middleware, and final credit settlement; it is not an end-to-end timer. Retried attempts produce separate entries, and their before-model time includes preceding attempts and retry waits.

Large before-model times point to database, authorization or source preparation work. Large provider times point to model/provider throughput, queueing or output length. Use representative user requests after deployment to compare total time and first visible text; do not infer generation throughput from the health endpoint alone.

## Deployment

The desktop change requires restarting the rebuilt Electron app or distributing a new packaged build. Backend changes require deploying this backend repository to its existing Render service. No environment, database policy, credit migration or model change is required. Backend behavior remains shared by all clients.

If the service uses Render's Free compute tier, Render documents an idle spin-down after 15 minutes and roughly a minute to start again. The hosting tier was not verified in this investigation; upgrading hosting is a separate paid decision, not something this patch changes. Source: https://render.com/docs/free

Validation covers configuration freshness/isolation, parallel authenticated reads after proof sync, provider timing, grammar prompts, and the existing credit/subscription/generation regression suites. A live generation speed comparison remains to be measured after deployment.
