import { Routes, Route, Navigate } from "react-router-dom";
import LoginPage from "@/pages/LoginPage";
import DashboardPage from "@/pages/DashboardPage";
import OptionsPage from "@/pages/OptionsPage";
import TradePage from "@/pages/TradePage";
import GeminiTradingPage from "@/pages/GeminiTradingPage";
import StreamingPage from "@/pages/StreamingPage";
import PortfolioPage from "@/pages/PortfolioPage";
import PredictionModelPage from "@/pages/PredictionModelPage";
import MlTradingPage from "@/pages/MlTradingPage";
import SettingsPage from "@/pages/SettingsPage";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<LoginPage />} />
      <Route path="/login" element={<Navigate to="/" replace />} />
      <Route path="/dashboard" element={<DashboardPage />} />
      <Route path="/dashboard/options" element={<OptionsPage />} />
      <Route path="/dashboard/streaming" element={<StreamingPage />} />
      <Route path="/dashboard/prediction" element={<PredictionModelPage />} />
      <Route path="/dashboard/ml-trading" element={<MlTradingPage />} />
      <Route path="/dashboard/gemini" element={<GeminiTradingPage />} />
      <Route path="/dashboard/trade" element={<TradePage />} />
      <Route path="/dashboard/portfolio" element={<PortfolioPage />} />
      <Route path="/dashboard/settings" element={<SettingsPage />} />
    </Routes>
  );
}
