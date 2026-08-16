import { useNavigate, useSearchParams } from "react-router-dom";
import { FormEvent, useEffect, useState } from "react";
import { Zap } from "lucide-react";
import { useAuth } from "@/contexts/auth-context";
import { getMissingFirebaseEnvKeys } from "@/lib/firebase";

type AuthTab = "signup" | "signin";

export default function LoginPage() {
  const { user, loading, signIn, signUp } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab: AuthTab = searchParams.get("tab") === "signin" ? "signin" : "signup";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const missingFirebase = getMissingFirebaseEnvKeys();

  useEffect(() => {
    if (!loading && user) navigate("/dashboard/nine-fifteen", { replace: true });
  }, [user, loading, navigate]);

  const switchTab = (next: AuthTab) => {
    setError("");
    setSearchParams(next === "signin" ? { tab: "signin" } : {}, { replace: true });
  };

  const handleSignIn = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      await signIn(email, password);
      navigate("/dashboard/nine-fifteen");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in failed");
    } finally {
      setSubmitting(false);
    }
  };

  const handleSignUp = async (e: FormEvent) => {
    e.preventDefault();
    setError("");

    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setSubmitting(true);
    try {
      await signUp(email, password);
      navigate("/dashboard/nine-fifteen");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign up failed");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading || user) {
    return (
      <div className="flex-center" style={{ minHeight: "100vh" }}>
        <div className="spinner" />
      </div>
    );
  }

  return (
    <div className="login-page">
      <div className="login-box">
        <div className="login-logo">
          <div className="logo" style={{ justifyContent: "center" }}>
            <div className="logo-icon">
              <Zap size={20} />
            </div>
            <span className="logo-text">9:15 Trader</span>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h2 className="card-title">{tab === "signup" ? "Create account" : "Sign in"}</h2>
            <p className="card-desc">
              {tab === "signup"
                ? "Sign up with any email — open to everyone"
                : "Welcome back — sign in to your account"}
            </p>
          </div>

          <div className="auth-tabs" role="tablist" aria-label="Authentication">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "signup"}
              className={`auth-tab${tab === "signup" ? " auth-tab-active" : ""}`}
              onClick={() => switchTab("signup")}
            >
              Sign up
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "signin"}
              className={`auth-tab${tab === "signin" ? " auth-tab-active" : ""}`}
              onClick={() => switchTab("signin")}
            >
              Sign in
            </button>
          </div>

          {missingFirebase.length > 0 && (
            <div className="alert alert-error">
              Firebase is not configured. On the server run:{" "}
              <code>npm run build && pm2 restart options-trading</code>
            </div>
          )}

          {tab === "signup" ? (
            <form onSubmit={handleSignUp}>
              <div className="field">
                <label className="label">Email</label>
                <input
                  className="input"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  required
                  autoComplete="email"
                />
              </div>
              <div className="field">
                <label className="label">Password</label>
                <input
                  className="input"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 6 characters"
                  required
                  minLength={6}
                  autoComplete="new-password"
                />
              </div>
              <div className="field">
                <label className="label">Confirm password</label>
                <input
                  className="input"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                  minLength={6}
                  autoComplete="new-password"
                />
              </div>
              {error && <div className="alert alert-error">{error}</div>}
              <button
                type="submit"
                className="btn btn-primary btn-full"
                disabled={submitting || missingFirebase.length > 0}
              >
                {submitting ? "Please wait..." : "Create account"}
              </button>
            </form>
          ) : (
            <form onSubmit={handleSignIn}>
              <div className="field">
                <label className="label">Email</label>
                <input
                  className="input"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  required
                  autoComplete="email"
                />
              </div>
              <div className="field">
                <label className="label">Password</label>
                <input
                  className="input"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                  autoComplete="current-password"
                />
              </div>
              {error && <div className="alert alert-error">{error}</div>}
              <button
                type="submit"
                className="btn btn-primary btn-full"
                disabled={submitting || missingFirebase.length > 0}
              >
                {submitting ? "Please wait..." : "Sign in"}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
