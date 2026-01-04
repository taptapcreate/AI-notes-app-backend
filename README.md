# AI App Backend

Backend server for AI Notes & Reply App using Gemini API.

## Deploy to Render

1. Push this `backend` folder to a GitHub repo
2. Go to [render.com](https://render.com) → New → Web Service
3. Connect your GitHub repo
4. Configure:
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Environment Variable**: Add `GEMINI_API_KEY`

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
