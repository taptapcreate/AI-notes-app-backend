# AI App Backend

Backend server for AI Notes & Reply App using OpenRouter.

## Deploy to Render

1. Push this `backend` folder to a GitHub repo
2. Go to [render.com](https://render.com) → New → Web Service
3. Connect your GitHub repo
4. Configure:
   - **Build Command**: `npm ci --omit=dev`
   - **Start Command**: `npm start`
   - **Runtime**: Node 22; configure the provider/database secrets in `.env.example` and follow `docs/credit-policy-rollout.md` before the policy switch

## Local Development

```bash
# Install dependencies
npm install

# Create .env file
cp .env.example .env
# Add your OPEN_ROUTER_API_KEY to .env

# Start server
npm start
```

## API Endpoints

Desktop consent providers and short privacy copy are configurable in the
existing master configuration; see [processing disclosure](docs/processing-disclosure.md).

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/notes` | POST | Generate notes from text, images, voice, PDFs, websites, and YouTube transcripts |
| `/api/reply` | POST | Generate reply options |
| `/api/health` | GET | Health check |

## Credit policy

See [the rollout guide](docs/credit-policy-rollout.md) for the one-time seven-credit
allowance, existing-user behavior, purchase verification requirements, and authenticated
generation billing. Existing production settings are changed only
by the explicit policy migration, not merely by deploying these source changes.

Run `npm test` to verify the credit rules with an isolated temporary MongoDB server.
Run `npm run credits:policy -- --dry-run` to inspect the intended database policy.

## Subscription timing diagnostics

After deploying this backend, subscription-status and Apple-proof verification requests
emit one structured `Subscription timing` log entry. Entries contain fixed operation
names, elapsed milliseconds, completion outcomes, and HTTP status only. They do not
include request bodies, query filters/results, recovery codes, account or transaction
identifiers, receipts, credentials, or raw error messages. Other requests are not traced.

Use only the `Subscription timing` entries when investigating renewal latency. The
`spans` distinguish account lookup, configuration reads, subscription queries,
transaction work, allowance calculations, signature verification, and RevenueCat calls.
Durations include nested operations: do not add overlapping spans together. Each
request retains at most 128 spans; additional spans are counted in `omittedSpans`.
Logging failures cannot change a subscription result. No additional database connection, migration,
new environment setting, or desktop rebuild is needed to enable these logs; deploy the
backend code through the existing Render workflow.


## Book Studio cost and recovery controls

Book Studio suggestion prompts keep small chapter contexts complete. Larger contexts use a hard 16,000-character JSON budget: the exact recent chapter ending, the author brief, nearby outline entries, and selected earlier excerpts. Excerpts are explicitly read-only context, not a generated summary; no extra summary-model request is made. Current 1–2-credit suggestion prices and page-based review prices are unchanged. Original manuscripts, selection/application snapshots and completed five-operation desktop history are preserved.

Multi-batch page reviews checkpoint validated generated edits in the new `bookreviewcheckpoints` collection. Its expiring index deletes checkpoints after 24 hours; original manuscripts, prompt bodies and recovery codes are not stored there. The key binds the authenticated account scope, exact content/settings, model and prompts. Atomic leases and fencing prevent simultaneous or stale workers from changing another attempt. A retry after a failed/expired generation reuses completed sections; a new polish after a delivered successful/unchanged result starts fresh. Empty no-change chunks are reusable too. Single-batch requests skip checkpoint writes.

Book Studio provider calls use at most three attempts per request, with jitter, cancellation and bounded `Retry-After` handling. A failed bulk section has at most four provider attempts total across resumptions within its checkpoint window. Permanent provider errors and truncated output do not trigger blind retries. Full revision validation rejects excessive shortening and (for updated desktops supplying the growth budget) chapter-size overflow before billing finalizes. Existing atomic reservations, mixed subscription/wallet allocation and refunds remain authoritative.

This is retry recovery within the existing HTTP pipeline, not an unattended job queue: the three-minute server deadline still applies. After an interruption, retry the same unchanged content to resume. There is no new infrastructure or pricing configuration. MongoDB must allow creation of the checkpoint collection and its expiry index; startup and the first bulk review initialize them. Deploy the backend to activate server-side protections. Desktop request metadata/help changes take effect in the next separately requested build. Neither deployment nor a desktop build is performed by preparing these changes.

Provider timing records now include available input/output/cache/reasoning token counts and reported USD cost, without prompt or response content. Missing provider usage is left unknown, never treated as free. Failed attempts can still have provider costs that were not returned; these controls reduce waste rather than guaranteeing zero API expense.

## Smart Notes preflight and spending safeguards

Every AI route now requires authentication and an idempotency key, even for legacy-shaped requests and even if an old database has `generationBillingRequired: false`. The public configuration reports required billing. Older clients without authenticated credit receipts must update; do not deploy this as an invisible compatibility change. No balances, prices, subscription allowances or purchase settings are changed.

Smart Notes accepts at most 24,000 UTF-8 bytes of serialized source text, 4,000 bytes of customization, and 32,000 bytes of the final textual provider prompt. These are conservative byte budgets, not token estimates. Unicode and JSON escapes count toward the limit. Oversized sources are rejected with `NOTE_SOURCE_TOO_LARGE`, never silently shortened. Mixed PDF local text counts toward the source budget. Related text transformation endpoints use the same source preflight; versioned Book Studio operations retain their own existing limits.

Smart Notes makes one model attempt, with provider fallbacks disabled and routing capped at $0.10/M input and $0.50/M output. A rejected cached PDF annotation is evicted but does not trigger a second model call. Other tools retain their existing retry policies, including Book Studio's bounded recovery. Existing token caps and credit refunds remain authoritative. Available provider usage continues to be logged without source text. A valid request that fails after processing begins can still incur API cost; these controls cannot guarantee zero expense.

The backend validates audio duration from the recording bytes before reservation/transcription: desktop PCM stays at five minutes with existing 2/3-credit quotes; mobile and legacy audio must fit three minutes. Unreadable or unknown-duration files fail locally. Narration requires the existing desktop billing contract and a valid 60-second PCM recording. Single and batch images are decoded locally, limited to 15 MB combined and 16 megapixels per input, then normalized to still JPEGs with a longest side of 2,048 pixels. The original desktop source is unchanged. Corrupt and animated files are rejected before narration or model processing. Dense digital PDFs (over the text budget), unreadable documents and pages over 20 inches per side fail before cloud OCR. Existing 1–10-page limits and cloud-page prices remain. Scanned PDFs still incur OCR/image/model costs; local text inspection is not a complete prediction of OCR output size or visual-token cost.

Persistent generation records enforce at most two running requests per account. Three failed requests in 15 minutes pause fresh requests from that account; cached receipts still replay freely. Twenty server/provider failures (HTTP 5xx) started within five minutes pause new generations globally for that window. Client validation errors do not trigger the global circuit. These cooldowns survive restarts, preserve refunds, and reject new requests before reservation/API work. The global circuit observes settled failures; already-running work is not a hard aggregate cash ceiling. Separate provider-account spending limits remain an additional operational safeguard.

The local decoders (`sharp`, `music-metadata`, `pdfjs-dist`) are pinned in package-lock.json. Deploy using the normal dependency installation on supported Node 22+; sharp's Linux optional binary must be installed. No extra paid service, AI request for preflight, desktop build, live configuration write, push or deployment is performed by preparing this code.
