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

## Attachment reuse and receipt completion (2026-11-21)

Successful audio transcripts and OpenRouter PDF parse annotations are now reusable within the same authenticated account. Cache identities hash the actual attachment bytes together with the account scope, model, processing version and audio format/PDF parser engine. Filenames, previous recordings and generated answers are not cache identities. Current instructions, language preferences and locally extracted PDF evidence are sent anew on every generation.

The cache is process-local memory only: ten-minute expiry, at most 32 results, 8 MiB total and 2 MiB per result. At most eight distinct extractions are shared in flight. A cache miss, eviction, restart or request on another server instance simply processes the attachment normally. It adds no disk/database copies of source material. Unauthenticated legacy requests bypass reuse.

Identical concurrent audio requests share extraction while retaining independent cancellation. One caller cancelling cannot cancel another caller; when every caller cancels, upstream work is aborted and late output cannot populate a replacement entry. Empty transcripts, failures and aborted extraction are not cached.

PDF reuse retains complete parsed text and embedded image evidence through OpenRouter's documented Chat Completions file annotations. Ambiguous multi-file annotations, changing streaming fragments, malformed/oversized data and expiring external image URLs are not cached. Invalid cached annotations receive one fresh-parse fallback on HTTP/in-stream 400 or 422, only before any text has been emitted. The generated answer is always new. Reference: https://openrouter.ai/docs/guides/overview/multimodal/pdfs#skip-parsing-costs

After generation, charging/refunds and result persistence still commit before the receipt is sent. The receipt uses a fresh read-only wallet snapshot instead of a full allowance/activity/checkpoint refresh for an initialized account. Daily rollover, legacy initialization, missing-wallet recovery and invalid/deleted accounts retain the original checks and fallback. Subscription usage is still calculated afresh; receipt balances are never cached. A receipt outage leaves the committed result recoverable with the same request ID without another AI call or charge.

`AI completion timing` records settlement, receipt and total finalization milliseconds without recording source content or account identities. Timing observers cannot invalidate a paid result. These changes preserve model/provider routing, requested output lengths, credit pricing and response/billing schemas.

Validation uses isolated MongoDB plus synthetic provider smoke tests, without private documents/recordings or app-wallet credits. The synthetic recording took about 2.9 seconds to transcribe initially and about 1 ms to reuse; changing the recording at the same filename or changing accounts made fresh calls with the correct content. A synthetic PDF's first request took about 2.3 seconds and its reused parse about 0.8 seconds; a different PDF/account did not reuse the earlier parse. These are small component-level samples, not guaranteed end-to-end production speedups.

Deployment: deploy this backend repository to the existing Render service using the established workflow. No database migration, new environment setting, model/routing switch or desktop rebuild is required. Existing clients automatically benefit after deployment; the cache starts empty.
