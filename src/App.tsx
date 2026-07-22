import { Routes, Route, Navigate } from "react-router-dom";
import LoginPage from "@/pages/LoginPage";
import NineFifteenPage from "@/pages/NineFifteenPage";
import PortfolioPage from "@/pages/PortfolioPage";
import SettingsPage from "@/pages/SettingsPage";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<LoginPage />} />
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route path="/dashboard" element={<Navigate to="/dashboard/nine-fifteen" replace />} />
      <Route path="/dashboard/nine-fifteen" element={<NineFifteenPage />} />
      <Route path="/dashboard/portfolio" element={<PortfolioPage />} />
      <Route path="/dashboard/settings" element={<SettingsPage />} />
      <Route path="*" element={<Navigate to="/dashboard/nine-fifteen" replace />} />
    </Routes>
  );
}
