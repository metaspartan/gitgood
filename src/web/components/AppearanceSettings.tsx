import { useState, type CSSProperties } from "react";
import { request } from "../api.ts";
import { useLive } from "../use-live.ts";
import { THEMES, themeById, themeVariables, type ThemeId } from "../themes.ts";
import { setInstanceTheme } from "../theme-client.ts";
import { ErrorBanner } from "../components.tsx";

export function AppearanceSettings() {
  const state = useLive(signal => request<{theme:ThemeId}>("/api/appearance", {signal}), []);
  const [selected, setSelected] = useState<ThemeId | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const current = selected ?? state.data?.theme ?? "midnight";
  const save = async () => {
    setBusy(true); setError(null); setNotice("");
    try {
      const result = await request<{theme:ThemeId}>("/api/admin/appearance", {method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({theme:current})});
      window.dispatchEvent(new Event("gitgood:theme-saved"));
      setInstanceTheme(result.theme); state.reload(); setNotice(`${themeById(result.theme)!.name} is now the instance theme.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save theme"); }
    finally { setBusy(false); }
  };
  return <section className="card appearance-settings" aria-labelledby="appearance-title">
    <h2 id="appearance-title">Appearance</h2><p className="muted small">One theme for this instance, including sign-in and repository pages. Other open tabs update within a minute or when revisited. People can override it for their own browser under Settings → Appearance. GitHub options are inspired palettes, not affiliated themes.</p>
    <ErrorBanner message={error ?? state.error} />
    {(["dark", "light"] as const).map(mode => <fieldset key={mode} className="theme-options"><legend>{mode === "dark" ? "Dark themes" : "Light themes"}</legend><div className="theme-grid">
      {THEMES.filter(theme => theme.mode === mode).map(theme => <label key={theme.id} className="theme-option" style={themeVariables(theme.id) as CSSProperties}>
        <input type="radio" name="instance-theme" value={theme.id} aria-label={theme.name} checked={current === theme.id} disabled={busy} onChange={() => {setSelected(theme.id);setNotice("");}} />
        <span className="theme-mini" aria-hidden="true"><span /><i /><i /><i /></span><span className="theme-name">{theme.name}</span>
      </label>)}
    </div></fieldset>)}
    <div className="theme-preview" style={themeVariables(current) as CSSProperties} aria-label="Selected theme preview"><strong>Repository overview</strong><p>Review code, collaborate, and ship.</p><code>main</code><span className="theme-preview-accent">Selected: {themeById(current)!.name}</span></div>
    <div className="row wrap" style={{marginTop:16}}><button type="button" className="primary" disabled={busy || !state.data || current === state.data.theme} onClick={() => void save()}>{busy ? "Saving\u2026" : "Apply instance theme"}</button><button type="button" className="ghost" disabled={busy || selected === null} onClick={() => setSelected(null)}>Reset selection</button></div>
    <p className="small" role="status">{notice}</p>
  </section>;
}
