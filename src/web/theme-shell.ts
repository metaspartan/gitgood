import { one } from "../db/index.ts";
import { readCookie } from "../lib/http.ts";
import { themeById, themeVariables, type ThemeId } from "./themes.ts";

export const THEME_COOKIE = "gg_theme";
const DEFAULT_THEME: ThemeId = "midnight";
const MAX_VARIANTS = 64;

export type ShellTheme = { kind: "fixed"; id: ThemeId } | { kind: "system"; light: ThemeId; dark: ThemeId };

interface Variant {
  html: Uint8Array;
  gzip: Uint8Array | null;
  etag: string;
}

const variants = new Map<string, Variant>();
let variantSource: Uint8Array | null = null;

export function instanceTheme(): ThemeId {
  const stored = one<{ theme: string }>("SELECT theme FROM instance_appearance WHERE id = 1");
  return themeById(stored?.theme)?.id ?? DEFAULT_THEME;
}

export function parseThemeCookie(value: string | null): ShellTheme | null {
  if (!value) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }
  const [kind, a, b] = decoded.split(":");
  if (kind === "fixed" && themeById(a)) return { kind: "fixed", id: a as ThemeId };
  if (kind === "system" && themeById(a)?.mode === "light" && themeById(b)?.mode === "dark") {
    return { kind: "system", light: a as ThemeId, dark: b as ThemeId };
  }
  return null;
}

export function shellThemeFor(request: Request): ShellTheme {
  return parseThemeCookie(readCookie(request, THEME_COOKIE)) ?? { kind: "fixed", id: instanceTheme() };
}

function declarations(id: ThemeId): string {
  return Object.entries(themeVariables(id))
    .map(([name, value]) => `${name}:${value.replace(/[;<>"{}]/g, "")}`)
    .join(";");
}

export function renderThemedShell(source: string, theme: ShellTheme): string {
  if (theme.kind === "fixed") {
    const meta = themeById(theme.id)!;
    const bg = themeVariables(theme.id)["--bg"] ?? "";
    return source
      .replace("<html lang=\"en\">", `<html lang="en" data-theme="${theme.id}" data-theme-mode="${meta.mode}" style="color-scheme:${meta.mode};${declarations(theme.id)}">`)
      .replace(/<meta name="theme-color" content="[^"]*" \/>/, `<meta name="theme-color" content="${bg}" />`);
  }
  const css = `@media (prefers-color-scheme: light){:root{color-scheme:light;${declarations(theme.light)}}}@media (prefers-color-scheme: dark){:root{color-scheme:dark;${declarations(theme.dark)}}}`;
  return source
    .replace("<html lang=\"en\">", `<html lang="en" data-theme="system">`)
    .replace("</head>", `<style id="theme-boot">${css}</style></head>`);
}

export function themedShell(indexHtml: Uint8Array, theme: ShellTheme): Variant {
  if (variantSource !== indexHtml) {
    variants.clear();
    variantSource = indexHtml;
  }
  const key = theme.kind === "fixed" ? `f:${theme.id}` : `s:${theme.light}:${theme.dark}`;
  const cached = variants.get(key);
  if (cached) return cached;
  const html = new TextEncoder().encode(renderThemedShell(new TextDecoder().decode(indexHtml), theme));
  const hasher = new Bun.CryptoHasher("sha1");
  hasher.update(html);
  const variant: Variant = { html, gzip: html.byteLength > 512 ? Bun.gzipSync(html) : null, etag: `W/"shell-${hasher.digest("hex").slice(0, 16)}"` };
  variants.set(key, variant);
  while (variants.size > MAX_VARIANTS) variants.delete(variants.keys().next().value as string);
  return variant;
}
