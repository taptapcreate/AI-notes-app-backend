# AI App Backend

Backend server for AI Notes & Reply App using Gemini API.

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
# Add your GEMINI_API_KEY to .env

# Start server
npm start
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/notes` | POST | Generate notes from text/image/voice |
| `/api/reply` | POST | Generate reply options |
| `/api/health` | GET | Health check |

## Credit policy

See [the rollout guide](docs/credit-policy-rollout.md) for the one-time seven-credit
allowance, existing-user behavior, purchase verification requirements, and authenticated
generation billing. Existing production settings are changed only
by the explicit policy migration, not merely by deploying these source changes.

Run `npm test` to verify the credit rules with an isolated temporary MongoDB server.
Run `npm run credits:policy -- --dry-run` to inspect the intended database policy.
