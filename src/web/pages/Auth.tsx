import { useState, type ReactNode } from "react";
import { api } from "../api.ts";
import { ErrorBanner, Notice } from "../components.tsx";
import { navigate } from "../router.tsx";
import { useSession } from "../App.tsx";

type Step = "credentials" | "second-factor";

export function safeNextPath(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  return /^\/[^\s]*$/.test(raw) ? raw : "/";
}

function postLoginTarget(): string {
  return safeNextPath(new URLSearchParams(window.location.search).get("next"));
}

export function LoginPage(): ReactNode {
  const { user, refresh } = useSession();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [step, setStep] = useState<Step>("credentials");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submitCredentials = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      if (mode === "signup") {
        await api.signup(username, email, password);
        refresh();
        navigate(postLoginTarget());
        return;
      }
      const result = await api.login(username, password);
      if (result.mfa_required) {
        setStep("second-factor");
        setCode("");
        return;
      }
      refresh();
      navigate(postLoginTarget());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Authentication failed");
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.loginMfa(username, password, code);
      if (result.mfa_required) {
        setError("That code was not accepted. Try the next one.");
        return;
      }
      refresh();
      navigate(postLoginTarget());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That code did not match");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <div className="card">
        <h2 style={{ marginTop: 0 }}>
          {step === "second-factor" ? "Two-factor authentication" : mode === "login" ? "Sign in" : "Create account"}
        </h2>
        {user && step === "credentials" ? (
          <Notice>You are already signed in as {user.username}.</Notice>
        ) : null}
        <ErrorBanner message={error} />

        {step === "second-factor" ? (
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              void submitCode();
            }}
          >
            <p className="muted small" style={{ marginTop: 0 }}>
              Enter the six-digit code from your authenticator app, or one of your recovery codes.
            </p>
            <label>
              Code
              <input
                name="code"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                autoComplete="one-time-code"
                inputMode="text"
                autoFocus
                required
              />
            </label>
            <div className="row">
              <button type="submit" className="primary" disabled={busy || code.trim().length < 6}>
                {busy ? "Checking…" : "Verify"}
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  setStep("credentials");
                  setCode("");
                  setError(null);
                }}
              >
                Back
              </button>
            </div>
          </form>
        ) : (
          <form
            className="stack"
            onSubmit={(event) => {
              event.preventDefault();
              void submitCredentials();
            }}
          >
            <label>
              Username
              <input
                name="username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="username"
                required
              />
            </label>
            {mode === "signup" ? (
              <label>
                Email
                <input
                  name="email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  autoComplete="email"
                  required
                />
              </label>
            ) : null}
            <label>
              Password
              <input
                name="password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                minLength={8}
                required
              />
            </label>
            <div className="row">
              <button type="submit" className="primary" disabled={busy}>
                {busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  setMode(mode === "login" ? "signup" : "login");
                  setError(null);
                }}
              >
                {mode === "login" ? "Need an account?" : "Have an account?"}
              </button>
            </div>
          </form>
        )}

      </div>
    </div>
  );
}

export function SignupForm(): ReactNode {
  return <LoginPage />;
}
