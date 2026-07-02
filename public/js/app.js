import { getUser, onAuthChange, signIn, signUp, signInGoogle, logOut } from "./auth.js";
import { getKite, onKiteChange, refreshKite, disconnectKite } from "./kite.js";
import { api, fmt, fmtCurrency, changeClass } from "./utils.js";

const app = document.getElementById("app");
const cfg = window.APP_CONFIG;

function qs() {
  const hash = location.hash.slice(1) || "/";
  const [path, query] = hash.split("?");
  return { path: path || "/", params: new URLSearchParams(query || "") };
}

function nav(path) {
  location.hash = path;
}

function shell(content, active) {
  const kite = getKite();
  const user = getUser();
  return `
    <div class="dashboard-layout">
      <button class="menu-btn" id="menuBtn" aria-label="Open menu">☰</button>
      <div class="overlay hidden" id="overlay"></div>
      <aside class="sidebar" id="sidebar">
        <div class="sidebar-header"><div class="logo"><div class="logo-icon">⚡</div><div><div>OptionFlow</div><div class="text-muted" style="font-size:.75rem">Options Trading</div></div></div></div>
        <nav class="nav">
          ${[["/dashboard","Overview"],["/trade","Trade"],["/options","Options Chain"],["/portfolio","Portfolio"],["/settings","Settings"]].map(([p,l])=>`<a href="#${p}" class="${active===p?'active':''}">${l}</a>`).join("")}
        </nav>
        <div class="sidebar-footer">
          <div class="user-box">
            <div class="truncate">${user?.email||"User"}</div>
            <span class="badge ${kite.connected?'badge-success':'badge-warning'}" style="margin-top:.35rem">${kite.connected?'Kite Connected':'Kite Offline'}</span>
            ${kite.profile?`<div class="text-muted truncate" style="font-size:.75rem;margin-top:.25rem">${kite.profile.user_id}</div>`:""}
          </div>
          <button class="btn btn-ghost btn-sm btn-full" id="logoutBtn">Sign out</button>
        </div>
      </aside>
      <main class="main">${content}</main>
    </div>`;
}

function landing() {
  return `
    <header class="landing-header">
      <div class="logo"><div class="logo-icon">⚡</div><span>OptionFlow</span></div>
      <div class="flex gap-2"><a href="#/login"><button class="btn btn-ghost">Sign in</button></a><a href="#/login"><button class="btn btn-primary">Get Started</button></a></div>
    </header>
    <section class="hero">
      <div class="hero-badge"><span class="pulse"></span> Powered by Zerodha Kite Connect</div>
      <h1>Trade options with <span class="gradient-text">institutional-grade</span> tools</h1>
      <p>A modern SaaS platform for Indian options traders. Connect Zerodha, analyze chains, and execute trades.</p>
      <div class="hero-actions"><a href="#/login"><button class="btn btn-primary btn-lg">Start Trading</button></a></div>
      <div class="card mt-4" style="text-align:left;margin-top:2rem">
        <div class="preview-grid">
          <div class="preview-card"><div class="text-muted" style="font-size:.75rem">NIFTY 50</div><div style="font-size:1.25rem;font-weight:600">24,850.30</div><div class="text-up">+0.42%</div></div>
          <div class="preview-card"><div class="text-muted" style="font-size:.75rem">BANK NIFTY</div><div style="font-size:1.25rem;font-weight:600">52,140.75</div><div class="text-down">-0.18%</div></div>
          <div class="preview-card"><div class="text-muted" style="font-size:.75rem">Portfolio P&L</div><div style="font-size:1.25rem;font-weight:600">₹12,450</div><div class="text-up">+2.1%</div></div>
        </div>
      </div>
    </section>
    <section class="features-section"><h2 style="text-align:center;margin-bottom:2rem">Everything you need</h2>
      <div class="feature-grid">
        ${[["Live Options Chain","CE/PE with OI and volume"],["Order Execution","Market and limit orders"],["Portfolio","Positions and P&L"],["Secure","Server-side Kite tokens"]].map(([t,d])=>`<div class="glass feature-card"><h3>${t}</h3><p class="text-muted mt-3">${d}</p></div>`).join("")}
      </div>
    </section>
    <footer class="landing-footer text-muted">OptionFlow — Indian options trading</footer>`;
}

function loginView() {
  return `<div class="login-wrap"><div class="login-box">
    <div style="text-align:center;margin-bottom:2rem"><a href="#/" class="logo" style="justify-content:center"><div class="logo-icon">⚡</div><span>OptionFlow</span></a></div>
    <div class="card">
      <h2 id="loginTitle">Welcome back</h2><p class="text-muted mt-3" id="loginDesc">Sign in to your dashboard</p>
      <form id="loginForm" class="mt-4">
        <div class="field"><label class="label">Email</label><input class="input" type="email" id="email" required></div>
        <div class="field"><label class="label">Password</label><input class="input" type="password" id="password" minlength="6" required></div>
        <div id="loginError" class="alert alert-error hidden"></div>
        <button class="btn btn-primary btn-full" type="submit" id="loginSubmit">Sign in</button>
      </form>
      <div class="divider">OR</div>
      <button class="btn btn-outline btn-full" id="googleBtn">Continue with Google</button>
      <p class="text-muted text-center mt-4" style="font-size:.875rem"><span id="toggleText">Don't have an account?</span> <button class="link-btn" id="toggleMode">Sign up</button></p>
    </div></div></div>`;
}

async function dashboardView() {
  const kite = getKite();
  let watchHtml = `
    <div class="empty-state">
      <div class="empty-state-icon">📈</div>
      <div class="empty-state-title">No live quotes yet</div>
      <p>Connect your Zerodha Kite account to stream NIFTY, BANK NIFTY, and watchlist prices.</p>
    </div>`;
  let stats = { pnl: "—", positions: "—", status: "Offline" };
  if (kite.connected) {
    try {
      const [{ data: quotes }, { data: pos }] = await Promise.all([
        api(`/api/kite/quotes?instruments=${cfg.watchlist.join(",")}`),
        api("/api/kite/positions"),
      ]);
      const net = (pos?.net || []).filter(p => p.quantity !== 0);
      const totalPnl = net.reduce((s,p)=>s+(p.pnl||0),0);
      stats = { pnl: fmtCurrency(totalPnl), positions: String(net.length), status: "Live" };
      watchHtml = cfg.watchlist.map(key => {
        const q = quotes[key]; const sym = key.split(":")[1]; const ch = q?.change_percent||0;
        return `<div class="watch-item flex-between mb-4"><div><div>${sym}</div><div class="text-muted" style="font-size:.75rem">${key.split(":")[0]}</div></div><div class="text-right"><div>${q?fmt(q.last_price):"—"}</div><div class="${changeClass(ch)}">${q?(ch>=0?"+":"")+ch.toFixed(2)+"%":""}</div></div></div>`;
      }).join("");
    } catch(e) { watchHtml = `<div class="alert alert-error">${e.message}</div>`; }
  }
  const connectBanner = kite.configured && !kite.connected ? `<div class="card connect-banner mb-6"><div class="flex-between"><div><strong>Connect Zerodha</strong><p class="text-muted mt-3" style="font-size:.875rem">Link your Kite account to unlock live market data and order placement.</p></div>${kite.loginUrl?`<a href="${kite.loginUrl}"><button class="btn btn-primary">Connect Kite</button></a>`:""}</div></div>` : "";
  return shell(`${connectBanner}
    <div class="page-header mb-8"><h1>Dashboard</h1><p>Your trading overview</p></div>
    <div class="grid-4 mb-8">
      ${[["Day P&L",stats.pnl],["Open Positions",stats.positions],["Watchlist",cfg.watchlist.length],["Market Status",stats.status]].map(([l,v])=>`<div class="card"><div class="stat-label">${l}</div><div class="stat-value">${v}</div></div>`).join("")}
    </div>
    <div class="grid-2">
      <div class="card"><h3>Watchlist</h3><div class="mt-4">${watchHtml}</div></div>
      <div class="card"><h3>Quick Actions</h3>
        <a class="action-link" href="#/options"><strong>Options Chain</strong><div class="text-muted">Analyze strikes</div></a>
        <a class="action-link" href="#/trade"><strong>Place Order</strong><div class="text-muted">Buy or sell</div></a>
        <a class="action-link" href="#/portfolio"><strong>Portfolio</strong><div class="text-muted">Positions & P&L</div></a>
      </div>
    </div>`, "/dashboard");
}

function tradeView() {
  const kite = getKite();
  if (!kite.connected) return shell(`<div class="page-header mb-8"><h1>Trade</h1></div><div class="card"><p class="text-muted">Connect Zerodha first.</p>${kite.loginUrl?`<a href="${kite.loginUrl}"><button class="btn btn-primary mt-4">Connect Kite</button></a>`:""}</div>`, "/trade");
  return shell(`<div class="page-header mb-8"><h1>Trade</h1><p>Place options orders</p></div>
    <div class="grid-2"><div class="card"><form id="orderForm">
      <div class="grid-2"><div class="field"><label class="label">Symbol</label><input class="input" name="tradingsymbol" placeholder="NIFTY25JUL24800CE" required></div>
      <div class="field"><label class="label">Exchange</label><select class="select" name="exchange"><option>NFO</option><option>BFO</option></select></div></div>
      <div class="flex gap-2 mb-4"><button type="button" class="btn btn-outline active-buy" data-side="BUY">BUY</button><button type="button" class="btn btn-outline" data-side="SELL">SELL</button></div>
      <input type="hidden" name="transaction_type" value="BUY">
      <div class="grid-2"><div class="field"><label class="label">Order Type</label><select class="select" name="order_type"><option>MARKET</option><option>LIMIT</option><option>SL</option></select></div>
      <div class="field"><label class="label">Product</label><select class="select" name="product"><option>MIS</option><option>NRML</option></select></div>
      <div class="field"><label class="label">Quantity</label><input class="input" type="number" name="quantity" required min="1"></div></div>
      <div id="orderMsg"></div><button class="btn btn-primary mt-4" type="submit">Place Order</button>
    </form></div><div class="card"><h3>Tips</h3><ul class="text-muted mt-4" style="line-height:1.8;font-size:.875rem"><li>MIS = intraday</li><li>NRML = overnight F&O</li><li>Use lot size multiples</li></ul><span class="badge badge-warning mt-4">Live orders — real money</span></div></div>`, "/trade");
}

async function optionsView() {
  const kite = getKite();
  if (!kite.connected) return shell(`<div class="page-header mb-8"><h1>Options Chain</h1></div><div class="card"><p class="text-muted">Connect Zerodha first.</p>${kite.loginUrl?`<a href="${kite.loginUrl}"><button class="btn btn-primary mt-4">Connect</button></a>`:""}</div>`, "/options");
  let chainHtml = `<div class="spinner"></div>`;
  let symbol = "NIFTY", exchange = "NFO";
  try {
    const { data } = await api(`/api/kite/option-chain?symbol=${symbol}&exchange=${exchange}`);
    chainHtml = `<p class="text-muted mb-4">Expiry: <strong>${data.expiry}</strong> · Spot: ${fmt(data.spotPrice)}</p>
      <div class="card card-flush table-wrap"><table style="min-width:900px"><thead><tr><th colspan="4" class="text-center text-up">CALLS</th><th class="text-center">STRIKE</th><th colspan="4" class="text-center text-down">PUTS</th></tr>
      <tr style="font-size:.75rem"><th class="text-right">OI</th><th class="text-right">Vol</th><th class="text-right">Chg%</th><th class="text-right">LTP</th><th></th><th class="text-right">LTP</th><th class="text-right">Chg%</th><th class="text-right">Vol</th><th class="text-right">OI</th></tr></thead><tbody>
      ${data.chain.map(r=>`<tr><td class="text-right text-muted">${r.ce?.quote?.oi?.toLocaleString("en-IN")||"—"}</td><td class="text-right text-muted">${r.ce?.quote?.volume?.toLocaleString("en-IN")||"—"}</td><td class="text-right ${changeClass(r.ce?.quote?.change_percent||0)}">${r.ce?.quote?((r.ce.quote.change_percent>=0?"+":"")+r.ce.quote.change_percent.toFixed(2)+"%"):"—"}</td><td class="text-right text-up">${r.ce?.quote?fmt(r.ce.quote.last_price):"—"}</td><td class="text-center"><strong>${fmt(r.strike,0)}</strong></td><td class="text-right text-down">${r.pe?.quote?fmt(r.pe.quote.last_price):"—"}</td><td class="text-right ${changeClass(r.pe?.quote?.change_percent||0)}">${r.pe?.quote?((r.pe.quote.change_percent>=0?"+":"")+r.pe.quote.change_percent.toFixed(2)+"%"):"—"}</td><td class="text-right text-muted">${r.pe?.quote?.volume?.toLocaleString("en-IN")||"—"}</td><td class="text-right text-muted">${r.pe?.quote?.oi?.toLocaleString("en-IN")||"—"}</td></tr>`).join("")}
      </tbody></table></div>`;
  } catch(e) { chainHtml = `<div class="alert alert-error">${e.message}</div>`; }
  const tabs = cfg.underlyings.map(u=>`<button class="btn btn-sm btn-outline">${u.label}</button>`).join(" ");
  return shell(`<div class="page-header mb-8"><h1>Options Chain</h1><p>Live CE/PE from Kite</p></div><div class="flex gap-2 mb-4 flex-wrap">${tabs}</div>${chainHtml}`, "/options");
}

async function portfolioView() {
  const kite = getKite();
  if (!kite.connected) return shell(`<div class="page-header mb-8"><h1>Portfolio</h1></div><div class="card"><p class="text-muted">Connect Zerodha first.</p></div>`, "/portfolio");
  let html = "";
  try {
    const { data: pos } = await api("/api/kite/positions");
    const net = (pos?.net||[]).filter(p=>p.quantity!==0);
    html = net.length ? `<table><thead><tr><th>Symbol</th><th>Product</th><th class="text-right">Qty</th><th class="text-right">P&L</th></tr></thead><tbody>${net.map(p=>`<tr><td>${p.tradingsymbol}</td><td><span class="badge badge-default">${p.product}</span></td><td class="text-right">${p.quantity}</td><td class="text-right ${changeClass(p.pnl)}">${fmtCurrency(p.pnl)}</td></tr>`).join("")}</tbody></table>` : `<p class="text-muted" style="padding:1rem">No open positions.</p>`;
  } catch(e) { html = `<div class="alert alert-error">${e.message}</div>`; }
  return shell(`<div class="page-header mb-8"><h1>Portfolio</h1></div><div class="card card-flush table-wrap">${html}</div>`, "/portfolio");
}

function settingsView() {
  const kite = getKite();
  const user = getUser();
  const { params } = qs();
  const alert = params.get("kite")==="connected" ? `<div class="alert alert-success">Connected to Zerodha!</div>` :
    params.get("message") ? `<div class="alert alert-error">${decodeURIComponent(params.get("message"))}</div>` : "";
  return shell(`${alert}<div class="page-header mb-8"><h1>Settings</h1><p>Manage your account and Zerodha connection</p></div><div class="grid-2">
    <div class="card"><h3>Account</h3><p class="text-muted mt-3">${user?.email||"—"}</p><p class="text-muted mt-3" style="font-size:.75rem">${user?.uid||""}</p></div>
    <div class="card"><div class="flex-between mb-4"><h3>Zerodha Kite</h3><span class="badge ${kite.connected?'badge-success':kite.configured?'badge-warning':'badge-danger'}">${kite.connected?'Connected':kite.configured?'Disconnected':'Unavailable'}</span></div>
      ${!kite.configured?`<p class="text-muted" style="font-size:.875rem">Zerodha integration is not available right now. Please try again later.</p>`:
        kite.connected?`<p><strong>${kite.profile?.user_name||"Connected"}</strong></p><p class="text-muted mt-3">${kite.profile?.user_id||""}</p><button class="btn btn-danger btn-sm mt-4" id="disconnectBtn">Disconnect</button>`:
        (kite.loginUrl?`<p class="text-muted" style="font-size:.875rem;margin-bottom:1rem">Sign in with your Zerodha account to enable live data and trading.</p><a href="${kite.loginUrl}"><button class="btn btn-primary">Connect Zerodha</button></a>`:"")}
    </div>
  </div>`, "/settings");
}

function bindShellEvents() {
  document.getElementById("menuBtn")?.addEventListener("click", () => {
    document.getElementById("sidebar")?.classList.toggle("open");
    document.getElementById("overlay")?.classList.toggle("hidden");
  });
  document.getElementById("overlay")?.addEventListener("click", () => {
    document.getElementById("sidebar")?.classList.remove("open");
    document.getElementById("overlay")?.classList.add("hidden");
  });
  document.getElementById("logoutBtn")?.addEventListener("click", async () => { await logOut(); nav("/login"); });
  document.getElementById("disconnectBtn")?.addEventListener("click", async () => { await disconnectKite(); render(); });
  document.getElementById("orderForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = Object.fromEntries(fd.entries());
    body.tradingsymbol = String(body.tradingsymbol).toUpperCase();
    body.validity = "DAY";
    const msg = document.getElementById("orderMsg");
    try {
      const { data } = await api("/api/kite/orders", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(body) });
      msg.innerHTML = `<div class="alert alert-success">Order placed: ${data.order_id}</div>`;
    } catch(err) { msg.innerHTML = `<div class="alert alert-error">${err.message}</div>`; }
  });
  document.querySelectorAll("[data-side]").forEach(btn => btn.addEventListener("click", () => {
    document.querySelector('[name="transaction_type"]').value = btn.dataset.side;
    document.querySelectorAll("[data-side]").forEach(b => b.className = "btn btn-outline" + (b.dataset.side === btn.dataset.side ? (btn.dataset.side==="BUY"?" active-buy":" active-sell") : ""));
  }));
}

function bindLoginEvents() {
  let signUpMode = false;
  document.getElementById("toggleMode")?.addEventListener("click", () => {
    signUpMode = !signUpMode;
    document.getElementById("loginTitle").textContent = signUpMode ? "Create account" : "Welcome back";
    document.getElementById("loginSubmit").textContent = signUpMode ? "Create account" : "Sign in";
    document.getElementById("toggleMode").textContent = signUpMode ? "Sign in" : "Sign up";
    document.getElementById("toggleText").textContent = signUpMode ? "Already have an account?" : "Don't have an account?";
  });
  document.getElementById("loginForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = document.getElementById("loginError");
    err.classList.add("hidden");
    try {
      const email = document.getElementById("email").value;
      const password = document.getElementById("password").value;
      if (signUpMode) await signUp(email, password); else await signIn(email, password);
      nav("/dashboard");
    } catch(ex) { err.textContent = ex.message; err.classList.remove("hidden"); }
  });
  document.getElementById("googleBtn")?.addEventListener("click", async () => {
    try { await signInGoogle(); nav("/dashboard"); }
    catch(ex) { document.getElementById("loginError").textContent = ex.message; document.getElementById("loginError").classList.remove("hidden"); }
  });
}

const protectedRoutes = ["/dashboard","/trade","/options","/portfolio","/settings"];

async function render() {
  const { path } = qs();
  const user = getUser();
  if (protectedRoutes.includes(path) && !user) { nav("/login"); return; }
  if (path === "/login" && user) { nav("/dashboard"); return; }

  app.innerHTML = `<div class="spinner" style="margin-top:40vh"></div>`;
  let html = "";
  if (path === "/") html = landing();
  else if (path === "/login") html = loginView();
  else if (path === "/dashboard") html = await dashboardView();
  else if (path === "/trade") html = tradeView();
  else if (path === "/options") html = await optionsView();
  else if (path === "/portfolio") html = await portfolioView();
  else if (path === "/settings") html = settingsView();
  else html = landing();

  app.innerHTML = html;
  bindShellEvents();
  bindLoginEvents();
}

window.addEventListener("hashchange", render);
onAuthChange(render);
onKiteChange(() => {});
render();
