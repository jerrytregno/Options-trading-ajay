# Deploy on AWS Lightsail (Mumbai)

Use Lightsail when you want a **fixed static IP** for Kite Connect and a **server-side 9:16 bot** (no browser tab).

Production URL: **https://tradinganalystjry.com**

## Why Lightsail

| Feature | Lightsail | Vercel (current) |
|---------|-----------|------------------|
| Static IP | Included | Not guaranteed |
| Server 9:16 bot | Yes (`NINE_SIXTEEN_BOT_ENABLED=1`) | No (browser only) |
| Cost | ~$10–20/mo | Free tier |

---

## 1. Create Lightsail instance

1. [AWS Lightsail console](https://lightsail.aws.amazon.com/)
2. **Create instance**
3. **Region:** Mumbai (`ap-south-1`)
4. **Platform:** Linux/Unix
5. **Blueprint:** OS Only → **Ubuntu 24.04 LTS**
6. **Plan:** $10/mo (2 GB RAM) or $12/mo (2 vCPU) — enough for Node
7. Name: `options-trading`

## 2. Attach static IP

1. Instance → **Networking** tab
2. **Create static IP** → attach to `options-trading`
3. Copy the IP — e.g. `3.110.x.x` — this is your **Kite whitelist IP forever**

## 3. Open firewall ports

Instance → **Networking** → IPv4 firewall:

| Port | Purpose |
|------|---------|
| 22 | SSH (your IP only if possible) |
| 80 | HTTP (Let’s Encrypt) |
| 443 | HTTPS |

## 4. SSH and install stack

```bash
ssh -i LightsailDefaultKey-ap-south-1.pem ubuntu@YOUR_STATIC_IP

sudo apt update && sudo apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git nginx certbot python3-certbot-nginx
sudo npm install -g pm2
```

## 5. Clone and build

```bash
git clone https://github.com/jerrytregno/Options-Trading.git
cd Options-Trading
npm install
npm run build
mkdir -p data
```

## 6. Environment file

Create `/home/ubuntu/Options-Trading/.env` (never commit):

```env
NODE_ENV=production
PORT=3001
APP_URL=https://trade.yourdomain.com

KITE_API_KEY=your_key
KITE_API_SECRET=your_secret
KITE_WHITELIST_IPS=YOUR_LIGHTSAIL_STATIC_IP,122.186.158.142
KITE_TRADING_IP=YOUR_LIGHTSAIL_STATIC_IP
KITE_MARKET_PROTECTION=-1

# Server-side 9:16 auto trade (no browser tab)
NINE_SIXTEEN_BOT_ENABLED=1

# Do NOT use Vercel relay on Lightsail
# KITE_EGRESS_RELAY_URL=
# KITE_RELAY_SECRET=

VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_STORAGE_BUCKET=...
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...
```

Load env in production: the app reads `.env` via `server/load-env.ts`.

## 7. Start with PM2

```bash
cd ~/Options-Trading
pm2 start npm --name options-trading -- start
pm2 save
pm2 startup
# run the command pm2 prints
```

Check logs:

```bash
pm2 logs options-trading
# Should show: [nine-sixteen-bot] Server auto trade enabled
# Should show: [kite] Kite egress YOUR_STATIC_IP (whitelisted — direct)
```

## 8. Domain + HTTPS

Point DNS **A record** → Lightsail static IP.

Nginx config `/etc/nginx/sites-available/options-trading`:

```nginx
server {
  listen 80;
  server_name trade.yourdomain.com;

  location / {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Enable:

```bash
sudo ln -s /etc/nginx/sites-available/options-trading /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d trade.yourdomain.com
```

## 9. Kite Connect

At [developers.kite.trade](https://developers.kite.trade/):

| Setting | Value |
|---------|--------|
| Redirect URL | `https://trade.yourdomain.com/api/kite/callback` |
| IP whitelist | Your **Lightsail static IP** |

Open app → **Settings → Trading IP** — egress should match the static IP.

## 10. Daily routine (fully automatic trade)

1. **Before 9:15 IST** — open app on phone, go to **Settings**, tap **Connect Kite** (~30 sec)
2. Server saves token to `data/kite-session.json`
3. **9:16** — server bot runs automatically (no tab open)
4. **Exit** — when Nifty ±30 from 9:15 open, or 3:25 PM square-off

Enable/disable in app: **9:15 Candle → Server 9:16 bot (Lightsail)**

Or set `NINE_SIXTEEN_BOT_ENABLED=1` in `.env`.

---

## Deploy updates after code changes

Two scripts are included in the repo.

### On Lightsail (after `git pull` or rsync)

```bash
cd ~/Options-Trading
chmod +x deploy.sh   # first time only
./deploy.sh
```

With git on the server:

```bash
GIT_PULL=1 ./deploy.sh
```

This runs: `npm install` → `npm run build` → `pm2 restart options-trading`.

### From your Mac (rsync + deploy in one step)

After you commit and push locally:

```bash
cd "/Users/jerrytonsurya/Desktop/Options trading"
./scripts/deploy-from-mac.sh
```

Optional overrides:

```bash
DEPLOY_HOST=ubuntu@13.206.140.159 \
DEPLOY_KEY=~/Downloads/LightsailDefaultKey-ap-south-1.pem \
./scripts/deploy-from-mac.sh
```

The Mac script **does not overwrite** server `.env` (keeps your Lightsail secrets).

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Orders rejected (IP) | Whitelist Lightsail static IP in Kite; check Settings → Trading IP |
| Bot says “Connect Kite” | Login in Settings before 9:15 each day |
| Bot missed 9:16 | Check `pm2 logs`; instance must be running; `NINE_SIXTEEN_BOT_ENABLED=1` |
| HTTPS redirect fails | `APP_URL` must match domain exactly |

---

## Optional: keep Vercel for UI only

You can keep Vercel as a read-only dashboard and run **only the bot** on Lightsail, but simplest is **one Lightsail host** for everything.

See also: [DEPLOY.md](./DEPLOY.md) (Vercel setup).
