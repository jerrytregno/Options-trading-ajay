import { Moon, Sun } from "lucide-react";
import { useTheme } from "@/contexts/theme-context";
import { cn } from "@/lib/utils";

interface ThemeToggleProps {
  className?: string;
  compact?: boolean;
}

export function ThemeToggle({ className, compact = false }: ThemeToggleProps) {
  const { toggleTheme, isLight } = useTheme();

  return (
    <button
      type="button"
      className={cn("theme-toggle-btn", compact && "theme-toggle-btn-compact", className)}
      onClick={toggleTheme}
      aria-label={isLight ? "Switch to dark mode" : "Switch to light mode"}
      title={isLight ? "Dark mode" : "Light mode"}
    >
      {isLight ? <Moon size={16} /> : <Sun size={16} />}
      {!compact && <span>{isLight ? "Dark" : "Light"}</span>}
    </button>
  );
}
