import { Link, useLocation } from "react-router-dom";
import {
  LayoutDashboard,
  LineChart,
  Settings,
  TrendingUp,
  Wallet,
  Zap,
  LogOut,
  Menu,
  X,
} from "lucide-react";
import { useState } from "react";
import { useAuth } from "@/contexts/auth-context";
import { useKite } from "@/contexts/kite-context";

const navItems = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/dashboard/trade", label: "Trade", icon: TrendingUp },
  { href: "/dashboard/options", label: "Options Chain", icon: LineChart },
  { href: "/dashboard/portfolio", label: "Portfolio", icon: Wallet },
  { href: "/dashboard/settings", label: "Settings", icon: Settings },
];

export function Sidebar() {
  const { pathname } = useLocation();
  const { user, signOut } = useAuth();
  const { connected, profile } = useKite();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button className="mobile-menu-btn" onClick={() => setOpen(!open)} aria-label="Menu">
        {open ? <X size={20} /> : <Menu size={20} />}
      </button>

      {open && <div className="sidebar-overlay" onClick={() => setOpen(false)} />}

      <aside className={`sidebar ${open ? "open" : ""}`}>
        <div className="sidebar-header">
          <div className="logo-icon"><Zap size={20} /></div>
          <div>
            <p className="font-semibold">OptionFlow</p>
            <p className="text-muted" style={{ fontSize: "0.75rem" }}>Options Trading</p>
          </div>
        </div>

        <nav className="sidebar-nav">
          {navItems.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              to={href}
              onClick={() => setOpen(false)}
              className={`nav-link ${pathname === href ? "active" : ""}`}
            >
              <Icon size={16} />
              {label}
            </Link>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="user-box">
            <p className="truncate font-medium" style={{ fontSize: "0.875rem" }}>
              {user?.displayName ?? user?.email ?? "User"}
            </p>
            <span className={`badge ${connected ? "badge-success" : "badge-warning"}`} style={{ marginTop: "0.25rem" }}>
              {connected ? "Kite Connected" : "Kite Offline"}
            </span>
            {profile && (
              <p className="truncate text-muted" style={{ fontSize: "0.75rem", marginTop: "0.25rem" }}>
                {profile.user_id}
              </p>
            )}
          </div>
          <button className="btn btn-ghost btn-sm btn-full" onClick={() => signOut()}>
            <LogOut size={16} />
            Sign out
          </button>
        </div>
      </aside>
    </>
  );
}
