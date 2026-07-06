import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { AuthProvider } from "@/contexts/auth-context";
import { ConfirmProvider } from "@/contexts/confirm-context";
import { KiteProvider } from "@/contexts/kite-context";
import { ThemeProvider } from "@/contexts/theme-context";
import App from "./App";
import "./index.css";
import "./styles/streaming-page.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <ThemeProvider>
        <AuthProvider>
          <KiteProvider>
            <ConfirmProvider>
              <App />
            </ConfirmProvider>
          </KiteProvider>
        </AuthProvider>
      </ThemeProvider>
    </BrowserRouter>
  </StrictMode>
);
