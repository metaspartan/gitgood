import { useState, type CSSProperties, type ReactNode } from "react";
import { THEMES, themeById, themeVariables, type ThemeId } from "../themes.ts";
import { DEFAULT_DARK, DEFAULT_LIGHT, readPreference, savePreference, type ThemePreference } from "../theme-client.ts";

function ThemeSwatches({
  name,
  mode,
  value,
  onChange,
}: {
  name: string;
  mode: "light" | "dark" | "any";
  value: ThemeId;
  onChange: (id: ThemeId) => void;
}): ReactNode {
  return (
    <div className="theme-grid">
      {[...THEMES].filter((theme) => mode === "any" || theme.mode === mode).sort((a, b) => (a.mode === b.mode ? 0 : a.mode === "dark" ? -1 : 1)).map((theme) => (
        <label key={theme.id} className="theme-option" style={themeVariables(theme.id) as CSSProperties}>
          <input type="radio" name={name} value={theme.id} aria-label={theme.name} checked={value === theme.id} onChange={() => onChange(theme.id)} />
          <span className="theme-mini" aria-hidden="true"><span /><i /><i /><i /></span>
          <span className="theme-name">{theme.name}</span>
        </label>
      ))}
    </div>
  );
}

export function PersonalAppearance(): ReactNode {
  const [pref, setPref] = useState<ThemePreference>(() => readPreference());
  const update = (next: ThemePreference): void => {
    setPref(next);
    savePreference(next);
  };
  const fixedTheme = pref.mode === "fixed" ? pref.theme : ((document.documentElement.dataset.theme as ThemeId | undefined) ?? DEFAULT_DARK);
  const light = pref.mode === "system" ? pref.light : DEFAULT_LIGHT;
  const dark = pref.mode === "system" ? pref.dark : DEFAULT_DARK;

  return (
    <section className="card appearance-settings" aria-labelledby="personal-appearance-title">
      <h2 id="personal-appearance-title" style={{ marginTop: 0 }}>Appearance</h2>
      <p className="muted small">Saved in this browser and applied instantly. Other people keep the instance theme.</p>
      <div className="segmented" role="radiogroup" aria-label="Theme mode" style={{ marginBottom: 14 }}>
        <button type="button" role="radio" aria-checked={pref.mode === "instance"} onClick={() => update({ mode: "instance" })}>
          Instance default
        </button>
        <button type="button" role="radio" aria-checked={pref.mode === "system"} onClick={() => update({ mode: "system", light, dark })}>
          Sync with system
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={pref.mode === "fixed"}

          onClick={() => update({ mode: "fixed", theme: themeById(fixedTheme) ? fixedTheme : DEFAULT_DARK })}
        >
          Single theme
        </button>
      </div>
      {pref.mode === "system" ? (
        <>
          <fieldset className="theme-options">
            <legend>Day theme (system is light)</legend>
            <ThemeSwatches name="personal-light" mode="light" value={light} onChange={(id) => update({ mode: "system", light: id, dark })} />
          </fieldset>
          <fieldset className="theme-options">
            <legend>Night theme (system is dark)</legend>
            <ThemeSwatches name="personal-dark" mode="dark" value={dark} onChange={(id) => update({ mode: "system", light, dark: id })} />
          </fieldset>
        </>
      ) : pref.mode === "fixed" ? (
        <fieldset className="theme-options">
          <legend>Theme</legend>
          <ThemeSwatches name="personal-fixed" mode="any" value={pref.theme} onChange={(id) => update({ mode: "fixed", theme: id })} />
        </fieldset>
      ) : (
        <p className="small faint" style={{ margin: 0 }}>Using the theme chosen by this instance's administrator.</p>
      )}
    </section>
  );
}
