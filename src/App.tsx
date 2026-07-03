import { Routes, Route } from "react-router-dom";
import LandingPage from "@/pages/LandingPage";
import LoginPage from "@/pages/LoginPage";
import DashboardPage from "@/pages/DashboardPage";
import OptionsPage from "@/pages/OptionsPage";
import TradePage from "@/pages/TradePage";
import StreamingPage from "@/pages/StreamingPage";
import PortfolioPage from "@/pages/PortfolioPage";
import SettingsPage from "@/pages/SettingsPage";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/dashboard" element={<DashboardPage />} />
      <Route path="/dashboard/options" element={<OptionsPage />} />
      <Route path="/dashboard/streaming" element={<StreamingPage />} />
      <Route path="/dashboard/trade" element={<TradePage />} />
      <Route path="/dashboard/portfolio" element={<PortfolioPage />} />
      <Route path="/dashboard/settings" element={<SettingsPage />} />
    </Routes>
  );
}
