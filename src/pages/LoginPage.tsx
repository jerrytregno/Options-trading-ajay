import { useNavigate } from "react-router-dom";
import { FormEvent, useEffect, useState } from "react";
import { Zap } from "lucide-react";
import { useAuth } from "@/contexts/auth-context";

export default function LoginPage() {
  const { user, loading, signIn } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!loading && user) navigate("/dashboard/nine-fifteen", { replace: true });
  }, [user, loading, navigate]);

  const handleSubmit = async (e: FormEvent) => {
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
            <h2 className="card-title">Sign in</h2>
            <p className="card-desc">Existing accounts only — view 9:15 candles and bot status</p>
          </div>

          <form onSubmit={handleSubmit}>
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
            <button type="submit" className="btn btn-primary btn-full" disabled={submitting}>
              {submitting ? "Please wait..." : "Sign in"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
