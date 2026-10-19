export const THEMES = [
  { id: "midnight", name: "Midnight", mode: "dark", colors: ["#0b0e14", "#12161f", "#0e1219", "#293241", "#465369", "#e6e9ef", "#adb8c8", "#95a3b7", "#4f8cff"] },
  { id: "black", name: "Carbon Black", mode: "dark", colors: ["#000000", "#101010", "#080808", "#292929", "#484848", "#f5f5f5", "#bdbdbd", "#a1a1a1", "#7aa7ff"] },
  { id: "github-dark", name: "GitHub Dark", mode: "dark", colors: ["#0d1117", "#151b23", "#010409", "#3d444d", "#656c76", "#f0f6fc", "#9198a1", "#8b929b", "#4493f8"] },
  { id: "nord", name: "Nord", mode: "dark", colors: ["#242933", "#2e3440", "#20252e", "#434c5e", "#626f85", "#eceff4", "#c3ccda", "#aab7ca", "#88c0d0"] },
  { id: "forest", name: "Evergreen", mode: "dark", colors: ["#0a1512", "#11221c", "#09110e", "#294237", "#496657", "#e6f1ea", "#b2c9bc", "#94b4a2", "#6bce9c"] },
  { id: "github-light", name: "GitHub Light", mode: "light", colors: ["#ffffff", "#ffffff", "#f6f8fa", "#d1d9e0", "#818b98", "#1f2328", "#59636e", "#59636e", "#0969da"] },
  { id: "porcelain", name: "Porcelain", mode: "light", colors: ["#f5f6f8", "#ffffff", "#eef0f4", "#d2d7e0", "#909aab", "#202939", "#475569", "#596579", "#2458c6"] },
  { id: "paper", name: "Warm Paper", mode: "light", colors: ["#faf7f1", "#fffdf8", "#f1ece2", "#d9cfc0", "#a29786", "#302a23", "#615649", "#716351", "#986018"] },
  { id: "ocean", name: "Ocean Mist", mode: "light", colors: ["#f2f8fc", "#ffffff", "#eaf2f8", "#c8dae7", "#819fb4", "#193348", "#395a70", "#4d697d", "#006ca8"] },
  { id: "sage", name: "Sage", mode: "light", colors: ["#f4f8f3", "#ffffff", "#eaf1e8", "#ccd9c8", "#8dA28a", "#243b28", "#45604b", "#586c58", "#287943"] },
  { id: "rose-pine", name: "Rosé Pine", mode: "dark", colors: ["#191724", "#1f1d2e", "#16141f", "#26233a", "#403d52", "#e0def4", "#908caa", "#9a95b3", "#ebbcba"] },
  { id: "contrast-dark", name: "High Contrast Dark", mode: "dark", colors: ["#000000", "#0c0c0c", "#000000", "#4a4a4a", "#6b6b6b", "#ffffff", "#d9d9d9", "#b0b0b0", "#7cc4ff"] },
  { id: "crimson", name: "Crimson", mode: "dark", colors: ["#140f12", "#1d161a", "#0f0b0d", "#3a2b31", "#57424a", "#f7eef1", "#cbb2ba", "#a08d95", "#ff6b81"] },
  { id: "solarized", name: "Solarized", mode: "light", colors: ["#fdf6e3", "#fffbf0", "#f5eedc", "#e3dbc8", "#b3ab97", "#22303c", "#5a6b74", "#54666f", "#0f7b8a"] },
  { id: "contrast-light", name: "High Contrast Light", mode: "light", colors: ["#ffffff", "#ffffff", "#f0f0f0", "#767676", "#525252", "#000000", "#333333", "#595959", "#0b4fc4"] },
  { id: "lavender", name: "Lavender Mist", mode: "light", colors: ["#f7f6fc", "#ffffff", "#eeecf6", "#d6d2e8", "#9b95b8", "#241f3d", "#4a4470", "#5f5980", "#5b3fd6"] },
  { id: "github-exact-dark", name: "GitHub 1:1 Dark", mode: "dark", colors: ["#0d1117", "#151b23", "#010409", "#3d444d", "#656c76", "#f0f6fc", "#9198a1", "#9198a1", "#4493f8"] },
  { id: "github-exact-light", name: "GitHub 1:1 Light", mode: "light", colors: ["#ffffff", "#f6f8fa", "#f6f8fa", "#d1d9e0", "#818b98", "#1f2328", "#59636e", "#59636e", "#0969da"] },
  { id: "everforest-dark", name: "Everforest Dark", mode: "dark", colors: ["#272e33", "#2e383c", "#232a2e", "#414b50", "#56635f", "#d3c6aa", "#c0b69c", "#a7b09a", "#a7c080"] },
  { id: "kanagawa", name: "Kanagawa", mode: "dark", colors: ["#1f1f28", "#2a2a37", "#16161d", "#363646", "#54546d", "#dcd7ba", "#c8c093", "#a6a69c", "#7e9cd8"] },
  { id: "monokai", name: "Monokai Pro", mode: "dark", colors: ["#2d2a2e", "#363337", "#221f22", "#49464a", "#6e6a70", "#fcfcfa", "#d0cdd1", "#b8b4ba", "#78dce8"] },
  { id: "solarized-light", name: "Solarized Light", mode: "light", colors: ["#fdf6e3", "#ffffff", "#eee8d5", "#ddd6c1", "#93a1a1", "#073642", "#4c5d61", "#55676b", "#1f6c9e"] },
  { id: "gruvbox-light", name: "Gruvbox Light", mode: "light", colors: ["#fbf1c7", "#fffaf0", "#f2e5bc", "#d5c4a1", "#a89984", "#282828", "#504945", "#5a524c", "#076678"] },
  { id: "ayu-dark", name: "Ayu Dark", mode: "dark", colors: ["#0b0e14", "#11151c", "#0d1017", "#1e232b", "#3a414c", "#e6e1cf", "#b3b1ad", "#959ca6", "#59c2ff"] },
  { id: "ayu-light", name: "Ayu Light", mode: "light", colors: ["#fcfcfc", "#ffffff", "#f3f4f5", "#e1e3e6", "#c5c9cf", "#3b4045", "#575e64", "#5c636a", "#1f6db0"] },
  { id: "tokyo-night-day", name: "Tokyo Night Day", mode: "light", colors: ["#e1e2e7", "#eeeff4", "#d5d6db", "#c4c8da", "#a8aecb", "#2e3a6e", "#414868", "#464d6b", "#2e5bb3"] },
  { id: "catppuccin-frappe", name: "Catppuccin Frapp\u00e9", mode: "dark", colors: ["#303446", "#292c3c", "#232634", "#414559", "#626880", "#c6d0f5", "#b5bfe2", "#a5adce", "#8caaee"] },
  { id: "night-owl", name: "Night Owl", mode: "dark", colors: ["#011627", "#0b2942", "#01111d", "#1d3b53", "#2e4a62", "#d6deeb", "#a8b4c6", "#8a9bb0", "#82aaff"] },
  { id: "github-dimmed", name: "GitHub Dimmed", mode: "dark", colors: ["#212830", "#262c36", "#151b23", "#3d444d", "#656c76", "#d1d7e0", "#9198a1", "#9198a1", "#539bf5"] },
  { id: "dracula", name: "Dracula", mode: "dark", colors: ["#21222c", "#282a36", "#1d1e26", "#44475a", "#6272a4", "#f8f8f2", "#d6d6e3", "#b8bcd6", "#bd93f9"] },
  { id: "tokyo-night", name: "Tokyo Night", mode: "dark", colors: ["#16161e", "#1a1b26", "#13131a", "#292e42", "#3b4261", "#c0caf5", "#a9b1d6", "#9aa5ce", "#7aa2f7"] },
  { id: "catppuccin-mocha", name: "Catppuccin Mocha", mode: "dark", colors: ["#181825", "#1e1e2e", "#11111b", "#313244", "#45475a", "#cdd6f4", "#bac2de", "#a6adc8", "#89b4fa"] },
  { id: "gruvbox-dark", name: "Gruvbox Dark", mode: "dark", colors: ["#1d2021", "#282828", "#171a1a", "#3c3836", "#504945", "#ebdbb2", "#d5c4a1", "#bdae93", "#83a598"] },
  { id: "one-dark", name: "One Dark", mode: "dark", colors: ["#21252b", "#282c34", "#1b1f24", "#3e4451", "#4b5263", "#dcdfe4", "#abb2bf", "#9da5b4", "#61afef"] },
  { id: "solarized-dark", name: "Solarized Dark", mode: "dark", colors: ["#002b36", "#073642", "#00212b", "#1d4b56", "#2f6170", "#eee8d5", "#c5c8bd", "#a9b4b3", "#2aa1d3"] },
  { id: "catppuccin-latte", name: "Catppuccin Latte", mode: "light", colors: ["#eff1f5", "#ffffff", "#e6e9ef", "#ccd0da", "#9ca0b0", "#4c4f69", "#5c5f77", "#5f6276", "#1e66f5"] },
  { id: "github-light-soft", name: "GitHub Light Soft", mode: "light", colors: ["#f6f8fa", "#ffffff", "#eff2f5", "#d1d9e0", "#8c959f", "#1f2328", "#424a53", "#59636e", "#0969da"] },
  { id: "rose-pine-dawn", name: "Rosé Pine Dawn", mode: "light", colors: ["#faf4ed", "#fffaf3", "#f2e9e1", "#dfdad9", "#9893a5", "#3c3657", "#575279", "#5e5a73", "#286983"] },
] as const;
export type ThemeId = typeof THEMES[number]["id"];
export function themeById(id: unknown) { return THEMES.find(theme => theme.id === id); }
const PRIMARY: Partial<Record<ThemeId, [string, string]>> = {
  "github-dimmed": ["#347d39", "#2e6f32"],
};

const GITHUB_DARK_STATUS = { "--success": "#3fb950", "--danger": "#f85149", "--warning": "#d29922", "--merged": "#ab7df8", "--contrib-0": "#151b23", "--contrib-1": "#033a16", "--contrib-2": "#196c2e", "--contrib-3": "#2ea043", "--contrib-4": "#56d364", "--contrib-outline": "rgba(240, 246, 252, 0.05)" };
const GITHUB_LIGHT_STATUS = { "--success": "#1a7f37", "--danger": "#d1242f", "--warning": "#9a6700", "--merged": "#8250df", "--contrib-0": "#eff2f5", "--contrib-1": "#aceebb", "--contrib-2": "#4ac26b", "--contrib-3": "#2da44e", "--contrib-4": "#116329", "--contrib-outline": "rgba(31, 35, 40, 0.05)" };
const GITHUB_STATUS: Partial<Record<ThemeId, Record<string, string>>> = {
  "github-dark": GITHUB_DARK_STATUS,
  "github-exact-dark": GITHUB_DARK_STATUS,
  "github-exact-light": GITHUB_LIGHT_STATUS,
  "github-dimmed": { ...GITHUB_DARK_STATUS, "--success": "#57ab5a", "--danger": "#e5534b", "--warning": "#c69026", "--merged": "#986ee2", "--contrib-0": "#2d333b", "--contrib-1": "#1b4721", "--contrib-2": "#2b6a30", "--contrib-3": "#46954a", "--contrib-4": "#6bc46d" },
  "github-light": GITHUB_LIGHT_STATUS,
  "github-light-soft": GITHUB_LIGHT_STATUS,
};

export function themeVariables(id: ThemeId): Record<string, string> {
  const theme = themeById(id)!;
  const keys = ["bg", "bg-elevated", "bg-inset", "border", "border-strong", "text", "text-dim", "text-faint", "accent"];
  const vars = Object.fromEntries(keys.map((key, i) => [`--${key}`, theme.colors[i]!]));
  const light = theme.mode === "light";
  return { ...vars,
    "--link": theme.colors[8],
    "--link-hover": theme.colors[8],
    "--accent-hover": `color-mix(in srgb, ${theme.colors[8]} 90%, ${light ? "#000000" : "#ffffff"})`,
    "--hover-bg": `color-mix(in srgb, ${theme.colors[6]} ${light ? 10 : 12}%, transparent)`,
    "--active-bg": `color-mix(in srgb, ${theme.colors[6]} ${light ? 15 : 18}%, transparent)`,
    "--counter-bg": `color-mix(in srgb, ${theme.colors[6]} ${light ? 14 : 20}%, transparent)`,
    "--underline-nav": light ? "#fd8c73" : "#f78166",
    "--btn-bg": `color-mix(in srgb, ${theme.colors[5]} ${light ? 3.5 : 7}%, ${theme.colors[1]})`,
    "--btn-hover-bg": `color-mix(in srgb, ${theme.colors[5]} ${light ? 6.5 : 11}%, ${theme.colors[1]})`,
    "--btn-active-bg": `color-mix(in srgb, ${theme.colors[5]} ${light ? 9 : 14}%, ${theme.colors[1]})`,
    "--btn-border": light ? theme.colors[3] : `color-mix(in srgb, ${theme.colors[5]} 13%, ${theme.colors[1]})`,
    "--btn-shadow": light ? "0 1px 0 #1f23280a" : "0 0 transparent",
    "--btn-primary-bg": PRIMARY[theme.id]?.[0] ?? "#1f883d",
    "--btn-primary-hover-bg": PRIMARY[theme.id]?.[1] ?? "#1a7f37",
    "--btn-primary-border": light ? "#1f23281a" : "#f0f6fc1a",
    "--btn-primary-text": "#ffffff",
    "--btn-danger-hover-bg": light ? "#cf222e" : "#da3633",
    "--btn-danger-hover-text": "#ffffff",
    "--focus-ring": theme.colors[8],
    "--checker-tile": theme.colors[3],
    "--selection-bg": `color-mix(in srgb, ${theme.colors[8]} 24%, ${theme.colors[1]})`,
    "--syntax-comment": theme.colors[7],
    "--syntax-string": light ? "#116329" : "#9ece6a",
    "--syntax-number": light ? "#953800" : "#ff9e64",
    "--syntax-keyword": light ? "#6639ba" : "#bb9af7",
    "--syntax-type": light ? "#0550ae" : "#7dcfff",
    "--syntax-function": light ? "#6639ba" : "#7aa2f7",
    "--syntax-tag": light ? "#a40e26" : "#f7768e",
    "--syntax-attr": light ? "#7d4e00" : "#e0af68",
    "--shadow-sm": light ? "0 1px 3px #1f293712" : "0 1px 2px #0004",
    "--shadow-md": light ? "0 4px 16px #1f293718" : "0 4px 16px -4px #0006",
    "--shadow-lg": light ? "0 16px 48px #1f293724" : "0 16px 48px -12px #0008", "--button-text": theme.mode === "light" ? "#ffffff" : "#08101c", "--bg-sunken": theme.colors[2], "--accent-dim": theme.colors[8], "--success": theme.mode === "light" ? "#167138" : "#64cc85", "--danger": theme.mode === "light" ? "#b42332" : "#ff827c", "--warning": theme.mode === "light" ? "#875800" : "#ddb94c", "--merged": theme.mode === "light" ? "#7543b5" : "#c3a2fa", "--shadow": theme.mode === "light" ? "0 2px 8px #1f293710" : "0 2px 8px #0004", ...(GITHUB_STATUS[theme.id] ?? {}) };
}

export type ThemePreference =
  | { mode: "instance" }
  | { mode: "fixed"; theme: ThemeId }
  | { mode: "system"; light: ThemeId; dark: ThemeId };

export function resolveTheme(pref: ThemePreference, instance: ThemeId | null, dark: boolean): ThemeId | null {
  if (pref.mode === "fixed") return pref.theme;
  if (pref.mode === "system") return dark ? pref.dark : pref.light;
  return instance;
}
