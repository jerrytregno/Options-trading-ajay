import { Link } from "react-router-dom";
import { ArrowRight, BarChart3, Shield, Zap, TrendingUp, LineChart } from "lucide-react";

const features = [
  { icon: LineChart, title: "Live Options Chain", description: "Real-time CE/PE data with OI, volume, and strike-wise pricing from Zerodha Kite." },
  { icon: TrendingUp, title: "Fast Order Execution", description: "Place market and limit orders directly through Kite Connect with one-click trading." },
  { icon: BarChart3, title: "Portfolio Analytics", description: "Track positions, P&L, holdings, and order history in a unified dashboard." },
  { icon: Shield, title: "Secure by Design", description: "Firebase authentication with server-side Kite token handling — secrets never hit the browser." },
];

export default function LandingPage() {
  return (
    <div>
      <header className="landing-header">
        <div className="logo">
          <div className="logo-icon"><Zap size={20} /></div>
          <span className="logo-text">OptionFlow</span>
        </div>
        <div className="flex gap-3">
          <Link to="/login"><button className="btn btn-ghost">Sign in</button></Link>
          <Link to="/login"><button className="btn btn-primary">Get Started</button></Link>
        </div>
      </header>

      <section className="hero">
        <div className="hero-badge">
          <span className="pulse" />
          Powered by Zerodha Kite Connect
        </div>
        <h1>Trade options with <span className="gradient-text">institutional-grade</span> tools</h1>
        <p>A modern SaaS platform for Indian options traders. Connect your Zerodha account, analyze live chains, and execute trades — all in one place.</p>
        <div className="hero-actions">
          <Link to="/login"><button className="btn btn-primary btn-lg">Start Trading <ArrowRight size={16} /></button></Link>
          <Link to="/login"><button className="btn btn-outline btn-lg">View Demo Dashboard</button></Link>
        </div>

        <div className="hero-preview">
          <div className="preview-inner">
            <div className="dots">
              <span className="dot" style={{ background: "#fb7185" }} />
              <span className="dot" style={{ background: "#fbbf24" }} />
              <span className="dot" style={{ background: "#34d399" }} />
            </div>
            <div className="grid-3">
              {[
                { label: "NIFTY 50", value: "24,850.30", change: "+0.42%", up: true },
                { label: "BANK NIFTY", value: "52,140.75", change: "-0.18%", up: false },
                { label: "Portfolio P&L", value: "₹12,450", change: "+2.1%", up: true },
              ].map((item) => (
                <div key={item.label} className="watchlist-item" style={{ flexDirection: "column", alignItems: "flex-start" }}>
                  <p className="text-muted" style={{ fontSize: "0.75rem" }}>{item.label}</p>
                  <p className="font-semibold" style={{ fontSize: "1.25rem", marginTop: "0.25rem" }}>{item.value}</p>
                  <p className={item.up ? "text-up" : "text-down"} style={{ fontSize: "0.875rem", marginTop: "0.25rem" }}>{item.change}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="features-section">
        <h2>Everything you need to trade options</h2>
        <div className="grid-2">
          {features.map(({ icon: Icon, title, description }) => (
            <div key={title} className="glass feature-card">
              <div className="feature-icon"><Icon size={20} /></div>
              <h3 className="font-semibold" style={{ fontSize: "1.125rem" }}>{title}</h3>
              <p className="text-muted mt-3" style={{ fontSize: "0.875rem" }}>{description}</p>
            </div>
          ))}
        </div>
      </section>

      <footer className="landing-footer">OptionFlow — Options trading platform for Indian markets</footer>
    </div>
  );
}
