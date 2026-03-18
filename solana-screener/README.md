# Solana Memecoin Screener

Rug pull detector + x2 potential scorer + staircase detection. Alerts via Discord webhook.

Live data from DEX Screener, Helius, rugcheck.xyz, Jupiter.

## Architecture

```
Frontend (React/Vite) ──→ Backend (Node.js/Express) ──→ APIs
     Vercel                   Railway/Render           DEX Screener
                                                       Helius RPC
                                                       rugcheck.xyz
                                                       Discord Webhook
```

## Setup Local

### 1. Backend

```bash
cd backend
npm install
cp .env.example .env
# Edit .env with your keys (see below)
node server.js
```

Backend runs on http://localhost:3001

### 2. Frontend

```bash
cd frontend
npm install
npm run dev
```

Frontend runs on http://localhost:5173

## API Keys (all free)

| Service | Get key at | Free tier |
|---------|-----------|-----------|
| Helius | https://helius.dev | 100K req/day |
| Discord Webhook | See below | Unlimited |
| DEX Screener | No key needed | Rate limited |
| rugcheck.xyz | No key needed | Rate limited |

### .env configuration

```
HELIUS_API_KEY=your_helius_key
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/xxxx/yyyy
PORT=3001
MIN_SAFETY_ALERT=60
MIN_POTENTIAL_ALERT=50
SCAN_INTERVAL_MS=30000
```

### Create Discord Webhook (2 minutes)

1. Open Discord, go to your server
2. Right-click a channel → Edit Channel → Integrations → Webhooks
3. Click "New Webhook"
4. Name it "Solana Screener"
5. Copy the Webhook URL
6. Paste it in .env as DISCORD_WEBHOOK_URL

### What the alerts look like

Each alert is a rich embed with:
- Token name + symbol
- Safety score (0-100) with color coding
- Potential x2 score (0-100)
- Price, MCap, Volume, Liquidity, Holders, Age
- Buys/Sells ratio
- Staircase warning if detected
- Direct link to DEX Screener
- Contract address in footer

Green embed = safe (75+), yellow = caution (50+), orange = risky (25+), red = danger (<25)

## Deploy (Free)

### Frontend → Vercel

1. Push to GitHub
2. Go to vercel.com, import the repo
3. Set root directory to `frontend`
4. Framework: Vite
5. Add env variable: `VITE_API_URL` = your Railway backend URL

### Backend → Railway

1. Go to railway.app
2. New project → Deploy from GitHub
3. Set root directory to `backend`
4. Add env variables from .env
5. Railway gives you a public URL

### Alternative: Backend → Render

1. Go to render.com
2. New Web Service → Connect GitHub
3. Root directory: `backend`
4. Build command: `npm install`
5. Start command: `node server.js`
6. Add env variables

## How it works

- Backend polls DEX Screener every 30s for new Solana token pairs
- Each new token gets scored (safety 0-100, potential 0-100)
- Staircase pattern detection runs on price history
- rugcheck.xyz verifies contract (mint, freeze, LP lock)
- Discord webhook fires when tokens pass your thresholds
- Frontend displays everything in real-time with 15s auto-refresh
