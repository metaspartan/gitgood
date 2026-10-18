import { resolveTheme, themeById, themeVariables, type ThemeId, type ThemePreference } from "./themes.ts";
export type { ThemePreference } from "./themes.ts";
import "./themes.css";

const PREF_KEY = "gitgood:theme-preference";
const CACHE_KEY = "gitgood:theme";
export const DEFAULT_LIGHT: ThemeId = "github-light";
export const DEFAULT_DARK: ThemeId = "github-dark";

let instanceTheme: ThemeId | null = null;

export function readPreference(): ThemePreference {
  try {
    const raw = JSON.parse(localStorage.getItem(PREF_KEY) ?? "null") as Partial<{ mode: string; theme: string; light: string; dark: string }> | null;
    if (raw?.mode === "fixed" && themeById(raw.theme)) return { mode: "fixed", theme: raw.theme as ThemeId };
    if (raw?.mode === "system") {
      const light = themeById(raw.light)?.mode === "light" ? (raw.light as ThemeId) : DEFAULT_LIGHT;
      const dark = themeById(raw.dark)?.mode === "dark" ? (raw.dark as ThemeId) : DEFAULT_DARK;
      return { mode: "system", light, dark };
    }
  } catch {
  }
  return { mode: "instance" };
}

function prefersDark(): boolean {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return true;
  }
}


export function applyTheme(id: ThemeId) {
  const theme = themeById(id)!;
  const root = document.documentElement;
  for (const [name, value] of Object.entries(themeVariables(id))) root.style.setProperty(name, value);
  root.dataset.theme = id;
  root.dataset.themeMode = theme.mode;
  root.style.colorScheme = theme.mode;
  try { localStorage.setItem(CACHE_KEY, id); } catch {}
}

function applyResolved(): void {
  const id = resolveTheme(readPreference(), instanceTheme, prefersDark());
  if (id) applyTheme(id);
}

function writeThemeCookie(pref: ThemePreference): void {
  const value = pref.mode === "fixed" ? `fixed:${pref.theme}` : pref.mode === "system" ? `system:${pref.light}:${pref.dark}` : "";
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = value
    ? `gg_theme=${encodeURIComponent(value)}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`
    : `gg_theme=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
}

export function savePreference(pref: ThemePreference): void {
  try { localStorage.setItem(PREF_KEY, JSON.stringify(pref)); } catch {}
  writeThemeCookie(pref);
  applyResolved();
}

export function setInstanceTheme(id: ThemeId): void {
  instanceTheme = id;
  applyResolved();
}

export function initializeTheme() {
  try {
    const existing = readPreference();
    if (existing.mode !== "instance" && !document.cookie.includes("gg_theme=")) writeThemeCookie(existing);
  } catch {}
  const pref = readPreference();
  const immediate = pref.mode === "instance" ? themeById(localStorage.getItem(CACHE_KEY))?.id ?? null : resolveTheme(pref, null, prefersDark());
  try { if (immediate) applyTheme(immediate); } catch {}

  try {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (readPreference().mode === "system") applyResolved();
    });
  } catch {}
  window.addEventListener("storage", (event) => {
    if (event.key === PREF_KEY) applyResolved();
  });

  let busy = false;
  let generation = 0;
  window.addEventListener("gitgood:theme-saved", () => { generation++; });
  const sync = async () => {
    if (busy || document.hidden) return;
    busy = true;
    const started = generation;
    try {
      const response = await fetch("/api/appearance");
      if (!response.ok) return;
      const data = await response.json(); const theme = themeById(data.theme);
      if (theme && started === generation) {
        instanceTheme = theme.id;
        applyResolved();
      }
    } catch {} finally { busy = false; }
  };
  void sync();
  setInterval(() => void sync(), 60000);
  document.addEventListener("visibilitychange", () => void sync());
  window.addEventListener("online", () => void sync());
}
