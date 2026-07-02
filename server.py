#!/usr/bin/env python3
"""
OptionFlow API server — no npm required.
Uses only Python standard library.

Run: python3 server.py
Open: http://localhost:8080
"""

from __future__ import annotations

import hashlib
import json
import os
import ssl
import urllib.error
import urllib.parse
import urllib.request
from http import cookies
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Dict, Optional

ROOT = Path(__file__).parent
PUBLIC = ROOT / "public"
KITE_BASE = "https://api.kite.trade"
TOKEN_COOKIE = "kite_access_token"
PORT = int(os.environ.get("PORT", "8080"))


def load_env_file(path: Path):
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_env_file(ROOT / ".env.local")
load_env_file(ROOT / ".env")


def env(key: str, default: str = "") -> str:
    return os.environ.get(key, default)


def kite_config():
    api_key = env("KITE_API_KEY")
    api_secret = env("KITE_API_SECRET")
    app_url = env("APP_URL", f"http://localhost:{PORT}")
    configured = bool(api_key and api_key != "your_api_key")
    return {"configured": configured, "api_key": api_key, "api_secret": api_secret, "app_url": app_url}


def login_url():
    cfg = kite_config()
    if not cfg["configured"]:
        return None
    redirect = f"{cfg['app_url']}/api/kite/callback"
    q = urllib.parse.urlencode({"v": "3", "api_key": cfg["api_key"], "redirect_url": redirect})
    return f"https://kite.zerodha.com/connect/login?{q}"


def http_json(method: str, url: str, headers: Optional[Dict[str, str]] = None, data: Optional[bytes] = None):
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("User-Agent", "OptionFlow/1.0")
    if headers:
        for k, v in headers.items():
            req.add_header(k, v)
    ctx = ssl.create_default_context()
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=30) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            return resp.status, body
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        return e.code, body


def kite_get(path: str, token: str):
    cfg = kite_config()
    status, body = http_json(
        "GET",
        f"{KITE_BASE}{path}",
        headers={"X-Kite-Version": "3", "Authorization": f"token {cfg['api_key']}:{token}"},
    )
    data = json.loads(body)
    if data.get("status") == "error":
        raise RuntimeError(data.get("message", "Kite API error"))
    return data.get("data")


def kite_post_form(path: str, token: Optional[str], fields: dict):
    cfg = kite_config()
    headers = {"X-Kite-Version": "3", "Content-Type": "application/x-www-form-urlencoded"}
    if token:
        headers["Authorization"] = f"token {cfg['api_key']}:{token}"
    status, body = http_json(
        "POST",
        f"{KITE_BASE}{path}",
        headers=headers,
        data=urllib.parse.urlencode(fields).encode(),
    )
    data = json.loads(body)
    if data.get("status") == "error":
        raise RuntimeError(data.get("message", "Kite API error"))
    return data.get("data")


def parse_instruments_csv(csv_text: str):
    lines = csv_text.strip().split("\n")
    if not lines:
        return []
    headers = lines[0].split(",")
    out = []
    for line in lines[1:]:
        vals = line.split(",")
        row = {headers[i].strip(): vals[i].strip() if i < len(vals) else "" for i in range(len(headers))}
        out.append(
            {
                "instrument_token": int(row.get("instrument_token") or 0),
                "tradingsymbol": row.get("tradingsymbol", ""),
                "name": row.get("name", ""),
                "expiry": row.get("expiry") or None,
                "strike": float(row["strike"]) if row.get("strike") else None,
                "lot_size": int(row.get("lot_size") or 0),
                "instrument_type": row.get("instrument_type", ""),
                "exchange": row.get("exchange", ""),
            }
        )
    return out


def fetch_instruments(exchange: str):
    _, body = http_json("GET", f"{KITE_BASE}/instruments/{exchange}", headers={"X-Kite-Version": "3"})
    return parse_instruments_csv(body)


def build_option_chain(instruments, quotes: dict):
    by_strike = {}
    for inst in instruments:
        strike = inst.get("strike")
        if not strike:
            continue
        row = by_strike.setdefault(strike, {"strike": strike})
        key = f"{inst['exchange']}:{inst['tradingsymbol']}"
        q = quotes.get(key)
        enriched = {**inst, "quote": None}
        if q:
            enriched["quote"] = {
                "last_price": q.get("last_price", 0),
                "change": q.get("change", 0),
                "change_percent": q.get("change_percent", 0),
                "volume": q.get("volume", 0),
                "oi": q.get("oi"),
            }
        if inst["instrument_type"] == "CE":
            row["ce"] = enriched
        elif inst["instrument_type"] == "PE":
            row["pe"] = enriched
    return sorted(by_strike.values(), key=lambda r: r["strike"])


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PUBLIC), **kwargs)

    def log_message(self, fmt, *args):
        print(f"[{self.log_date_time_string()}] {fmt % args}")

    def read_cookie(self, name: str):
        c = cookies.SimpleCookie(self.headers.get("Cookie", ""))
        if name in c:
            return c[name].value
        return None

    def set_cookie(self, name: str, value: str, max_age=86400):
        c = cookies.SimpleCookie()
        c[name] = value
        c[name]["path"] = "/"
        c[name]["httponly"] = True
        c[name]["samesite"] = "Lax"
        c[name]["max-age"] = str(max_age)
        self.send_header("Set-Cookie", c.output(header="").strip())

    def clear_cookie(self, name: str):
        c = cookies.SimpleCookie()
        c[name] = ""
        c[name]["path"] = "/"
        c[name]["max-age"] = "0"
        self.send_header("Set-Cookie", c.output(header="").strip())

    def send_json(self, data, status=200, extra_headers=None):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        if extra_headers:
            for k, v in extra_headers:
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def read_json_body(self):
        length = int(self.headers.get("Content-Length", 0))
        if not length:
            return {}
        return json.loads(self.rfile.read(length).decode())

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)

        if path.startswith("/api/"):
            return self.handle_api_get(path, qs)

        if path != "/" and not (PUBLIC / path.lstrip("/")).exists() and "." not in path.split("/")[-1]:
            self.path = "/index.html"
        return super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.startswith("/api/"):
            return self.handle_api_post(parsed.path)
        self.send_error(404)

    def handle_api_get(self, path: str, qs: dict):
        cfg = kite_config()

        if path == "/api/kite/status":
            token = self.read_cookie(TOKEN_COOKIE)
            if not cfg["configured"]:
                return self.send_json({"configured": False, "connected": False, "profile": None, "loginUrl": None})
            if not token:
                return self.send_json({"configured": True, "connected": False, "profile": None, "loginUrl": login_url()})
            try:
                profile = kite_get("/user/profile", token)
                return self.send_json({"configured": True, "connected": True, "profile": profile, "loginUrl": login_url()})
            except Exception:
                return self.send_json({"configured": True, "connected": False, "profile": None, "loginUrl": login_url()})

        if path == "/api/kite/callback":
            request_token = (qs.get("request_token") or [None])[0]
            status = (qs.get("status") or [None])[0]
            base = cfg["app_url"]
            if status == "success" and request_token and cfg["configured"]:
                try:
                    checksum = hashlib.sha256(f"{cfg['api_key']}{request_token}{cfg['api_secret']}".encode()).hexdigest()
                    session = kite_post_form(
                        "/session/token",
                        None,
                        {"api_key": cfg["api_key"], "request_token": request_token, "checksum": checksum},
                    )
                    self.send_response(302)
                    self.set_cookie(TOKEN_COOKIE, session["access_token"])
                    self.send_header("Location", f"{base}/#/dashboard?kite=connected")
                    self.end_headers()
                    return
                except Exception as e:
                    msg = urllib.parse.quote(str(e))
                    self.send_response(302)
                    self.send_header("Location", f"{base}/#/settings?kite=error&message={msg}")
                    self.end_headers()
                    return
            self.send_response(302)
            self.send_header("Location", f"{base}/#/settings?kite=failed")
            self.end_headers()
            return

        token = self.read_cookie(TOKEN_COOKIE)
        if not token:
            return self.send_json({"error": "Not connected to Zerodha"}, 401)

        try:
            if path == "/api/kite/quotes":
                instruments = (qs.get("instruments") or [""])[0]
                if not instruments:
                    return self.send_json({"error": "instruments required"}, 400)
                keys = [i.strip() for i in instruments.split(",") if i.strip()]
                query = "&".join(f"i={urllib.parse.quote(k)}" for k in keys)
                data = kite_get(f"/quote?{query}", token)
                return self.send_json({"data": data})

            if path == "/api/kite/option-chain":
                symbol = (qs.get("symbol") or ["NIFTY"])[0]
                exchange = (qs.get("exchange") or ["NFO"])[0]
                all_inst = fetch_instruments(exchange)
                opts = [i for i in all_inst if i["name"] == symbol and i["instrument_type"] in ("CE", "PE")]
                if not opts:
                    return self.send_json({"error": f"No options for {symbol}"}, 404)
                expiries = sorted({i["expiry"] for i in opts if i["expiry"]})
                nearest = expiries[0]
                expiry_opts = [i for i in opts if i["expiry"] == nearest]
                keys = [f"{i['exchange']}:{i['tradingsymbol']}" for i in expiry_opts]
                query = "&".join(f"i={urllib.parse.quote(k)}" for k in keys)
                quotes = kite_get(f"/quote?{query}", token)
                chain = build_option_chain(expiry_opts, quotes)
                spot_key = "BSE:SENSEX" if exchange == "BFO" else "NSE:NIFTY 50"
                spot = 0
                try:
                    sq = kite_get(f"/quote?i={urllib.parse.quote(spot_key)}", token)
                    spot = sq.get(spot_key, {}).get("last_price", 0)
                except Exception:
                    pass
                return self.send_json({"data": {"symbol": symbol, "exchange": exchange, "expiry": nearest, "expiries": expiries, "spotPrice": spot, "chain": chain}})

            if path == "/api/kite/positions":
                return self.send_json({"data": kite_get("/portfolio/positions", token)})
            if path == "/api/kite/holdings":
                return self.send_json({"data": kite_get("/portfolio/holdings", token)})
            if path == "/api/kite/orders":
                return self.send_json({"data": kite_get("/orders", token)})

            return self.send_json({"error": "Not found"}, 404)
        except Exception as e:
            return self.send_json({"error": str(e)}, 401)

    def handle_api_post(self, path: str):
        if path == "/api/kite/disconnect":
            self.send_json({"success": True}, extra_headers=[("Set-Cookie", f"{TOKEN_COOKIE}=; Path=/; Max-Age=0")])
            return

        token = self.read_cookie(TOKEN_COOKIE)
        if not token:
            return self.send_json({"error": "Not connected to Zerodha"}, 401)

        if path == "/api/kite/orders":
            try:
                body = self.read_json_body()
                fields = {k: str(v) for k, v in body.items()}
                data = kite_post_form("/orders/regular", token, fields)
                return self.send_json({"data": data})
            except Exception as e:
                return self.send_json({"error": str(e)}, 400)

        return self.send_json({"error": "Not found"}, 404)


def main():
    if not PUBLIC.exists():
        raise SystemExit(f"Missing public folder: {PUBLIC}")
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"\n  OptionFlow running at http://localhost:{PORT}")
    print("  No npm required — Python stdlib only\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
