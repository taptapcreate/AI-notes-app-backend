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
