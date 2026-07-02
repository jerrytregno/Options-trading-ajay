# OptionFlow — Options Trading Platform

## Run without npm (recommended if install fails)

Uses **Python 3** (already on your Mac) + static HTML/JS. **Zero dependencies.**

```bash
cd "/Users/jerrytonsurya/Desktop/Options trading"
python3 server.py
```

Open **http://localhost:8080**

Or:

```bash
chmod +x run.sh
./run.sh
```

### Setup

1. Firebase keys are in `public/js/config.js` (already set)
2. Enable Email/Google auth in [Firebase Console](https://console.firebase.google.com/)
3. Add Kite keys to `.env.local`:

```env
KITE_API_KEY=your_actual_key
KITE_API_SECRET=your_actual_secret
APP_URL=http://localhost:8080
```

4. Kite redirect URL: `http://localhost:8080/api/kite/callback`

---

## Alternative: Vite + npm (if install works later)

```bash
npm install
npm run dev
```

Frontend: http://localhost:5173 · API: http://localhost:3001

---

## If npm still won't install

Try these in order:

```bash
# 1. Clear npm cache
npm cache clean --force

# 2. Install Bun (often works when npm hangs)
curl -fsSL https://bun.sh/install | bash
bun install

# 3. Check network/proxy
npm config get proxy
npm config get registry
```

**Simplest path:** use `python3 server.py` — no npm needed.

## Features

- SaaS landing + Firebase login
- Zerodha Kite OAuth (server-side)
- Dashboard, options chain, trade, portfolio, settings
