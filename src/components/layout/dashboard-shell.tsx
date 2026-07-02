import { useEffect } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "@/contexts/auth-context";
import { Sidebar } from "@/components/layout/sidebar";

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex-center" style={{ minHeight: "100vh" }}>
        <div className="spinner" />
      </div>
    );
  }

  if (!user) return <Navigate to="/login" replace />;

  return (
    <div className="dashboard-layout">
      <Sidebar />
      <main className="dashboard-main">{children}</main>
    </div>
  );
}
