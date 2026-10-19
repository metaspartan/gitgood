import { useEffect, useState, type ReactNode } from "react";
import "./SettingsTokens.css";
import { api } from "../api.ts";
import { ErrorBanner, Notice, Spinner, timeAgo, useAsync } from "../components.tsx";
import { useSession } from "../App.tsx";
import { Link, useLocation } from "../router.tsx";
import { CommitEmailsPanel, SettingsNav, SshKeysPanel, settingsSectionFrom, UserRunnersPanel } from "../components/SettingsShell.tsx";
import type { PasskeyChallenge } from "../types.ts";
import { PersonalAppearance } from "../components/PersonalAppearance.tsx";
import { SessionsPanel } from "../components/SessionsPanel.tsx";

export function SettingsPage(): ReactNode {
  const { user, refresh } = useSession();
  const section = settingsSectionFrom(useLocation());
  const account = useAsync(() => (user ? api.accountSettings() : Promise.resolve(null)), [user?.id ?? 0]);
  const mfa = useAsync(() => (user ? api.mfaState() : Promise.resolve(null)), [user?.id ?? 0]);
  const tokens = useAsync(() => (user ? api.tokens() : Promise.resolve({ items: [] })), [user?.id ?? 0]);

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [profileFields, setProfileFields] = useState({ bio: "", company: "", location: "", website: "" });
  const [savingProfile, setSavingProfile] = useState(false);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);

  const [enrolling, setEnrolling] = useState<{ secret: string; uri: string } | null>(null);
  const [enrollCode, setEnrollCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [mfaCode, setMfaCode] = useState("");
  const [passkeyLabel, setPasskeyLabel] = useState("");
  const [busyMfa, setBusyMfa] = useState(false);

  const [tokenName, setTokenName] = useState("");
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [tokenScope, setTokenScope] = useState<"read" | "write">("write");
  const [tokenRepo, setTokenRepo] = useState("");

  useEffect(() => {
    if (account.data) {
      setUsername(account.data.user.username);
      setEmail(account.data.user.email ?? "");
      setDisplayName(account.data.user.display_name);
      const fields = account.data.user;
      setProfileFields({ bio: fields.bio ?? "", company: fields.company ?? "", location: fields.location ?? "", website: fields.website ?? "" });
    }
  }, [account.data]);

  if (!user) {
    return (
      <div className="card">
        <h2>Settings</h2>
        <p className="muted">
          <Link to="/login">Sign in</Link> to manage your account.
        </p>
      </div>
    );
  }

  const act = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(label);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That did not work");
    }
  };

  const saveProfile = (): Promise<void> =>
    act("Profile saved.", async () => {
      setSavingProfile(true);
      try {
        await api.updateAccount({
          username: username.trim(),
          email: email.trim(),
          display_name: displayName.trim(),
          ...profileFields,
        });
        account.reload();
        refresh();
      } finally {
        setSavingProfile(false);
      }
    });

  const savePassword = (): Promise<void> =>
    act("Password changed. Other devices have been signed out.", async () => {
      setSavingPassword(true);
      try {
        await api.changePassword(currentPassword, newPassword);
        setCurrentPassword("");
        setNewPassword("");
      } finally {
        setSavingPassword(false);
      }
    });

  const beginTotp = (): Promise<void> =>
    act("Scan the code, then enter one code to confirm.", async () => {
      const result = await api.beginTotp();
      setEnrolling({ secret: result.secret, uri: result.uri });
      setEnrollCode("");
    });

  const confirmTotp = (): Promise<void> =>
    act("Two-factor authentication is on. Save your recovery codes.", async () => {
      const result = await api.confirmTotp(enrollCode);
      setRecoveryCodes(result.recovery_codes);
      setEnrolling(null);
      setEnrollCode("");
      mfa.reload();
    });

  const disableTotp = (): Promise<void> =>
    act("Two-factor authentication is off.", async () => {
      await api.disableTotp(mfaCode);
      setMfaCode("");
      setRecoveryCodes(null);
      mfa.reload();
    });

  const addPasskey = async (): Promise<void> => {
    setError(null);
    setNotice(null);
    if (typeof navigator === "undefined" || !navigator.credentials) {
      setError("This browser does not support passkeys.");
      return;
    }
    try {
      const challenge = (await api.passkeyRegisterChallenge(passkeyLabel.trim())) as PasskeyChallenge;
      const publicKey: PublicKeyCredentialCreationOptions = {
        challenge: base64UrlToBytes(challenge.challenge),
        rp: { name: challenge.rp.name, id: challenge.rp.id },
        user: {
          id: base64UrlToBytes(challenge.user.id),
          name: challenge.user.name,
          displayName: challenge.user.displayName,
        },
        pubKeyCredParams: challenge.pubKeyCredParams.map((p) => ({
          type: "public-key" as const,
          alg: p.alg,
        })),
        timeout: challenge.timeout,
        attestation: "none",
        authenticatorSelection: {
          residentKey: "preferred",
          userVerification: "preferred",
        },
      };
      const credential = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential | null;
      if (!credential) {
        setError("Passkey creation was cancelled.");
        return;
      }
      const response = credential.response as AuthenticatorAttestationResponse;
      const exported = response.getPublicKey?.();
      if (!exported) {
        setError("This browser did not return a usable public key.");
        return;
      }
      const jwk = await publicKeyToJwk(exported);
      await api.passkeyRegister({
        credential_id: credential.id,
        public_key: JSON.stringify(jwk),
        client_data_json: bytesToBase64Url(new Uint8Array(response.clientDataJSON)),
        label: passkeyLabel.trim(),
      });
      setPasskeyLabel("");
      mfa.reload();
      setNotice("Passkey added.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not add that passkey.");
    }
  };

  const removePasskey = (id: number): Promise<void> =>
    act("Passkey removed.", async () => {
      await api.deletePasskey(id);
      mfa.reload();
    });

  const myRepos = useAsync(
    () => (user ? api.tokenRepositories(user.username) : Promise.resolve({ items: [] })),
    [user?.id ?? 0],
  );
  const repoNames = (myRepos.data?.items ?? []).map((repo) => repo.full_name);
  const tokenScopeValues = tokenScope === "read" ? ["read"] : ["read", "write"];

  const createToken = (): Promise<void> =>
    act("Token created. Copy it now, it is shown once.", async () => {
      const token = await api.createToken(tokenName.trim(), {
        scopes: tokenScopeValues,
        ...(tokenRepo ? { repository: tokenRepo } : {}),
      });
      setCreatedToken(token.token ?? null);
      setTokenName("");
      tokens.reload();
    });

  return (
    <div className="settings-layout">
      <SettingsNav section={section} user={user} />
      <div className="settings-main">
      {account.data?.instance_bootstrap_pending ? (
        <Notice>
          <strong>This instance still uses its generated administrator credentials.</strong> Change the
          username, email and password below — any one of them clears this notice.
        </Notice>
      ) : null}

      <ErrorBanner message={error} />
      {notice ? <Notice>{notice}</Notice> : null}

      {section === "appearance" ? (
        <>
      <PersonalAppearance />
        </>
      ) : null}

      {section === "profile" ? (
        <>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Public profile</h2>
        <p className="muted small">
          Your username is part of every clone URL you have shared, so changing it moves your
          repositories to a new URL.
        </p>
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            void saveProfile();
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
          <label>
            Display name
            <input
              name="display-name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              autoComplete="name"
            />
          </label>
          <label>
            Bio
            <textarea
              name="bio"
              rows={3}
              maxLength={160}
              value={profileFields.bio}
              placeholder="Tell us a little bit about yourself"
              onChange={(event) => setProfileFields({ ...profileFields, bio: event.target.value })}
            />
            <span className="small faint">{160 - profileFields.bio.length} characters left</span>
          </label>
          <label>
            Company
            <input name="company" maxLength={100} value={profileFields.company} onChange={(event) => setProfileFields({ ...profileFields, company: event.target.value })} autoComplete="organization" />
          </label>
          <label>
            Location
            <input name="location" maxLength={100} value={profileFields.location} onChange={(event) => setProfileFields({ ...profileFields, location: event.target.value })} />
          </label>
          <label>
            Website
            <input name="website" type="text" inputMode="url" maxLength={200} value={profileFields.website} placeholder="https://" onChange={(event) => setProfileFields({ ...profileFields, website: event.target.value })} autoComplete="url" />
          </label>
          <div className="row">
            <button type="submit" className="primary" disabled={savingProfile}>
              {savingProfile ? "Saving…" : "Save profile"}
            </button>
            {user.is_admin ? <span className="badge">Admin</span> : null}
          </div>
        </form>
      </div>
        </>
      ) : null}

      {section === "profile" ? <CommitEmailsPanel /> : null}
      {section === "security" ? (
        <>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Password</h3>
        <p className="muted small">
          Changing your password signs out every other device. This one stays signed in.
        </p>
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            void savePassword();
          }}
        >
          <label>
            Current password
            <input
              name="current-password"
              type="password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <label>
            New password
            <input
              name="new-password"
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              autoComplete="new-password"
              minLength={8}
              required
            />
          </label>
          <div className="row">
            <button
              type="submit"
              className="primary"
              disabled={savingPassword || currentPassword.length === 0 || newPassword.length < 8}
            >
              {savingPassword ? "Changing…" : "Change password"}
            </button>
          </div>
        </form>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Two-factor authentication</h3>
        {mfa.loading ? (
          <Spinner label="Loading security settings" />
        ) : mfa.data?.totp_enabled ? (
          <>
            <p className="muted small" style={{ marginTop: 0 }}>
              Enabled. {mfa.data.recovery_codes_remaining} recovery code
              {mfa.data.recovery_codes_remaining === 1 ? "" : "s"} remaining.
            </p>
            <div className="stack" style={{ maxWidth: 320 }}>
              <label>
                Confirm with a current code to change anything here
                <input
                  value={mfaCode}
                  onChange={(event) => setMfaCode(event.target.value)}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="123456"
                />
              </label>
              <div className="row wrap">
                <button
                  type="button"
                  className="ghost small"
                  disabled={mfaCode.trim().length < 6 || busyMfa}
                  onClick={() => {
                    setBusyMfa(true);
                    void act("New recovery codes generated. The old ones no longer work.", async () => {
                      const result = await api.regenerateRecoveryCodes(mfaCode);
                      setRecoveryCodes(result.recovery_codes);
                      mfa.reload();
                    }).finally(() => setBusyMfa(false));
                  }}
                >
                  Regenerate recovery codes
                </button>
                <button
                  type="button"
                  className="ghost small"
                  disabled={mfaCode.trim().length < 6 || busyMfa}
                  onClick={() => {
                    setBusyMfa(true);
                    void disableTotp().finally(() => setBusyMfa(false));
                  }}
                >
                  Turn off
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            <p className="muted small" style={{ marginTop: 0 }}>
              An authenticator app generates a six-digit code that changes every 30 seconds. Losing the
              device is recoverable with the codes you get when you turn this on.
            </p>
            {enrolling ? (
              <div className="stack" style={{ maxWidth: 420 }}>
                <p className="small" style={{ margin: 0 }}>
                  Add this to your authenticator app — either the link or the secret below — then enter
                  the code it shows.
                </p>
                <a className="aside-cmd" href={enrolling.uri} style={{ overflowWrap: "anywhere" }}>
                  {enrolling.uri}
                </a>
                <code className="clone-hint">{enrolling.secret}</code>
                <label>
                  Code from the app
                  <input
                    value={enrollCode}
                    onChange={(event) => setEnrollCode(event.target.value)}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="123456"
                  />
                </label>
                <div className="row">
                  <button
                    type="button"
                    className="primary"
                    disabled={enrollCode.trim().length !== 6}
                    onClick={() => void confirmTotp()}
                  >
                    Confirm and turn on
                  </button>
                  <button type="button" className="ghost" onClick={() => setEnrolling(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" className="primary" onClick={() => void beginTotp()}>
                Set up an authenticator app
              </button>
            )}
          </>
        )}

        {recoveryCodes ? (
          <Notice>
            <strong>Save these recovery codes.</strong> Each works once, and they are shown only here.
            <ol className="mono small" style={{ marginBottom: 0, columns: 2 }}>
              {recoveryCodes.map((c) => (
                <li key={c} style={{ userSelect: "all" }}>
                  {c}
                </li>
              ))}
            </ol>
          </Notice>
        ) : null}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Passkeys</h3>
        <p className="muted small" style={{ marginTop: 0 }}>
          A passkey signs you in with your device — a fingerprint, a face, or a security key — instead of
          a password.
        </p>
        {mfa.data && mfa.data.passkeys.length > 0 ? (
          <table className="list">
            <thead>
              <tr>
                <th>Label</th>
                <th>Added</th>
                <th>Last used</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {mfa.data.passkeys.map((p) => (
                <tr key={p.id}>
                  <td>{p.label}</td>
                  <td className="faint small">{timeAgo(p.created_at)}</td>
                  <td className="faint small">{p.last_used_at ? timeAgo(p.last_used_at) : "never"}</td>
                  <td style={{ textAlign: "right" }}>
                    <button
                      type="button"
                      className="ghost small"
                      onClick={() => void removePasskey(p.id)}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="faint small">No passkeys yet.</p>
        )}
        <form
          className="row"
          style={{ marginTop: "var(--s3)" }}
          onSubmit={(event) => {
            event.preventDefault();
            void addPasskey();
          }}
        >
          <input
            value={passkeyLabel}
            onChange={(event) => setPasskeyLabel(event.target.value)}
            placeholder="What is this device? (optional)"
            aria-label="Passkey label"
          />
          <button type="submit" className="primary">
            Add a passkey
          </button>
        </form>
      </div>
        </>
      ) : null}

      {section === "sessions" ? (
        <>
      <SessionsPanel />
        </>
      ) : null}

      {section === "tokens" ? (
        <>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Personal access tokens</h3>
        <p className="muted small">
          Use a token as the password when cloning:{" "}
          <span className="mono">git clone https://{user.username}:TOKEN@…</span>
        </p>
        {createdToken ? (
          <Notice>
            Copy this token now, it is shown only once:
            <div className="mono" style={{ marginTop: 6, userSelect: "all" }}>
              {createdToken}
            </div>
          </Notice>
        ) : null}
        <form
          className="token-form"
          onSubmit={(event) => {
            event.preventDefault();
            void createToken();
          }}
        >
          <div className="token-field">
            <label htmlFor="token-name">Token name</label>
            <input
              id="token-name"
              name="token-name"
              value={tokenName}
              onChange={(event) => setTokenName(event.target.value)}
              placeholder="laptop"
              required
            />
          </div>
          <div className="token-field">
            <label htmlFor="token-scope">Access</label>
            <select
              id="token-scope"
              value={tokenScope}
              onChange={(event) => setTokenScope(event.target.value === "read" ? "read" : "write")}
            >
              <option value="write">Read and write</option>
              <option value="read">Read only</option>
            </select>
          </div>
          <div className="token-field">
            <label htmlFor="token-repository">Repository</label>
            <select
              id="token-repository"
              value={tokenRepo}
              onChange={(event) => setTokenRepo(event.target.value)}
              disabled={myRepos.loading}
            >
              <option value="">All repositories this account can reach</option>
              {repoNames.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </div>
          <button type="submit" className="primary" disabled={!tokenName.trim()}>
            Generate token
          </button>
        </form>
        <p className="small faint token-hint">
          {tokenRepo
            ? `This token can only reach ${tokenRepo}. It cannot administer this instance, even if the account is an administrator.`
            : "An account-wide token reaches every repository this account can read or write. Pin it to one repository when handing it to an agent."}
        </p>
        {tokens.loading ? (
          <Spinner />
        ) : (
          <table className="list" style={{ marginTop: "var(--s3)" }}>
            <thead>
              <tr>
                <th>Name</th>
                <th>Scope</th>
                <th>Last used</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(tokens.data?.items ?? []).map((token) => (
                <tr key={token.id}>
                  <td>
                    {token.name}
                    <span className="small faint token-repo-cell">
                      {token.repository ?? "all repositories"}
                    </span>
                  </td>
                  <td className="mono small">{token.scopes.join(", ")}</td>
                  <td className="faint small">{token.last_used_at ? timeAgo(token.last_used_at) : "never"}</td>
                  <td style={{ textAlign: "right" }}>
                    <button
                      type="button"
                      className="ghost small"
                      onClick={() => void act("Token revoked.", async () => {
                        await api.revokeToken(token.id);
                        tokens.reload();
                      })}
                    >
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
        </>
      ) : null}
      {section === "keys" ? <SshKeysPanel /> : null}
      {section === "runners" ? <UserRunnersPanel /> : null}
      </div>
    </div>
  );
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function publicKeyToJwk(spki: ArrayBuffer): Promise<JsonWebKey> {
  const key = await crypto.subtle.importKey(
    "spki",
    spki,
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["verify"],
  );
  return crypto.subtle.exportKey("jwk", key);
}
