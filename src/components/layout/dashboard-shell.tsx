import { Navigate } from "react-router-dom";
import { useAuth } from "@/contexts/auth-context";
import { Sidebar } from "@/components/layout/sidebar";
import { ThemeToggle } from "@/components/ui/ThemeToggle";

export function DashboardShell({
  children,
  hideSidebar = false,
}: {
  children: React.ReactNode;
  hideSidebar?: boolean;
}) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex-center" style={{ minHeight: "100vh" }}>
        <div className="spinner" />
      </div>
    );
  }

  if (!user) return <Navigate to="/" replace />;

  return (
    <div className={`dashboard-layout${hideSidebar ? " dashboard-layout-fullscreen" : ""}`}>
      {!hideSidebar && <Sidebar />}
      <div className="dashboard-theme-toggle">
        <ThemeToggle compact />
      </div>
      <main className="dashboard-main">{children}</main>
    </div>
  );
}
