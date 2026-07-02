import { Link, useNavigate } from "react-router-dom";
import { FormEvent, useEffect, useState } from "react";
import { Zap } from "lucide-react";
import { useAuth } from "@/contexts/auth-context";

export default function LoginPage() {
  const { user, loading, signIn, signUp, signInWithGoogle } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSignUp, setIsSignUp] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!loading && user) navigate("/dashboard", { replace: true });
  }, [user, loading, navigate]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      if (isSignUp) await signUp(email, password);
      else await signIn(email, password);
      navigate("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading || user) {
    return <div className="flex-center" style={{ minHeight: "100vh" }}><div className="spinner" /></div>;
  }

  return (
    <div className="login-page">
      <div className="login-box">
        <div className="login-logo">
          <Link to="/" className="logo" style={{ justifyContent: "center" }}>
            <div className="logo-icon"><Zap size={20} /></div>
            <span className="logo-text">OptionFlow</span>
          </Link>
        </div>

        <div className="card">
          <div className="card-header">
            <h2 className="card-title">{isSignUp ? "Create account" : "Welcome back"}</h2>
            <p className="card-desc">{isSignUp ? "Sign up to start trading options" : "Sign in to your trading dashboard"}</p>
          </div>

          <form onSubmit={handleSubmit}>
            <div className="field">
              <label className="label">Email</label>
              <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required />
            </div>
            <div className="field">
              <label className="label">Password</label>
              <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required minLength={6} />
            </div>
            {error && <div className="alert alert-error">{error}</div>}
            <button type="submit" className="btn btn-primary btn-full" disabled={submitting}>
              {submitting ? "Please wait..." : isSignUp ? "Create account" : "Sign in"}
            </button>
          </form>

          <div className="divider">OR</div>
          <button className="btn btn-outline btn-full" onClick={async () => {
            setError(""); setSubmitting(true);
            try { await signInWithGoogle(); navigate("/dashboard"); }
            catch (err) { setError(err instanceof Error ? err.message : "Google sign-in failed"); }
            finally { setSubmitting(false); }
          }} disabled={submitting}>
            Continue with Google
          </button>

          <p className="text-muted text-center mt-4" style={{ fontSize: "0.875rem" }}>
            {isSignUp ? "Already have an account?" : "Don't have an account?"}{" "}
            <button type="button" className="link-btn" onClick={() => { setIsSignUp(!isSignUp); setError(""); }}>
              {isSignUp ? "Sign in" : "Sign up"}
            </button>
          </p>
        </div>
      </div>
    </div>
  );
}
