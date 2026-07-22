# Deploy to Vercel

Production URL: **https://options-trading-yhys.vercel.app**

## 1. Connect GitHub to Vercel

1. Push this repo to GitHub.
2. [vercel.com](https://vercel.com) → **Add New Project** → import **Options-Trading**.
3. Framework: **Other** (uses `vercel.json`).
4. Deploy.

## 2. Environment variables (Vercel → Settings → Environment Variables)

Copy from `.env.local` into **Production** (and Preview if you use preview URLs):

| Variable | Example / notes |
|----------|-----------------|
| `APP_URL` | `https://options-trading-yhys.vercel.app` |
| `KITE_API_KEY` | From Kite Connect |
| `KITE_API_SECRET` | From Kite Connect |
| `KITE_RELAY_SECRET` | Random string — **same** value in local `.env.local` |
| `KITE_WHITELIST_IPS` | `175.184.252.162,122.186.158.142` |
| `KITE_MARKET_PROTECTION` | `-1` |
| `VITE_FIREBASE_*` | All Firebase client keys |
| `GEMINI_API_KEY` | Optional — AI trading |
| `GEMINI_MODEL` | `gemini-3.1-flash-lite` |

Do **not** set `KITE_EGRESS_RELAY_URL` on Vercel (only for local dev).

## 3. Kite Connect

1. [developers.kite.trade](https://developers.kite.trade/) → your app.
2. **Redirect URL:** `https://options-trading-yhys.vercel.app/api/kite/callback`
3. **IP whitelist:** after deploy, open the app → **Settings → Trading IP**, copy **Kite API egress**, add it to the whitelist (often `175.184.252.162` for Mumbai region).

## 4. Local dev via Vercel egress

In `.env.local`:

```env
KITE_EGRESS_RELAY_URL=https://options-trading-yhys.vercel.app
KITE_RELAY_SECRET=<same as Vercel>
```

Run `npm run dev` — off-whitelist home IPs route Kite orders through Vercel.

## 5. Redeploy

Every push to `main` auto-deploys if Vercel is linked to GitHub. Manual: Vercel dashboard → **Redeploy**.

## Notes

- **ML Trading / Prediction Python** features need `python3` locally; Vercel serverless does not run the Python pipeline — sync/match may show Python unavailable on production unless you add a separate Python host later.
- **Trading IP** is not a dedicated static IP on Vercel; check Settings after redeploys and update Kite whitelist if egress changes.
