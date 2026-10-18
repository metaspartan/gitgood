import { gitBytes } from "./run.ts";

export interface TreeFile {
  path: string;
  size: number;
}

export interface TreeIndex {
  files: TreeFile[];
  truncated: boolean;
  total: number;
}

export function parseTreeListing(output: Uint8Array, maxFiles: number): TreeIndex {
  const decoder = new TextDecoder();
  const files: TreeFile[] = [];
  let total = 0;
  let start = 0;
  for (let i = 0; i < output.length; i += 1) {
    if (output[i] !== 0) continue;
    const record = decoder.decode(output.subarray(start, i));
    start = i + 1;
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    const meta = record.slice(0, tab).split(/\s+/);
    if (meta[1] !== "blob" || meta[0] === "120000") continue;
    total += 1;
    if (files.length < maxFiles) {
      const size = Number(meta[3]);
      files.push({ path: record.slice(tab + 1), size: Number.isFinite(size) ? size : 0 });
    }
  }
  return { files, truncated: total > files.length, total };
}

export async function treeIndex(repoPath: string, sha: string, maxFiles: number): Promise<TreeIndex> {
  const output = await gitBytes(["ls-tree", "-r", "-l", "-z", "--full-tree", sha], {
    cwd: repoPath,
    timeoutMs: 60_000,
    maxBytes: 128 * 1024 * 1024,
  });
  return parseTreeListing(output, maxFiles);
}

const LANGUAGES: Record<string, { name: string; color: string }> = {
  ts: { name: "TypeScript", color: "#3178c6" }, tsx: { name: "TypeScript", color: "#3178c6" },
  mts: { name: "TypeScript", color: "#3178c6" }, cts: { name: "TypeScript", color: "#3178c6" },
  js: { name: "JavaScript", color: "#f1e05a" }, jsx: { name: "JavaScript", color: "#f1e05a" },
  mjs: { name: "JavaScript", color: "#f1e05a" }, cjs: { name: "JavaScript", color: "#f1e05a" },
  py: { name: "Python", color: "#3572A5" }, rs: { name: "Rust", color: "#dea584" },
  go: { name: "Go", color: "#00ADD8" }, java: { name: "Java", color: "#b07219" },
  kt: { name: "Kotlin", color: "#A97BFF" }, kts: { name: "Kotlin", color: "#A97BFF" },
  swift: { name: "Swift", color: "#F05138" }, c: { name: "C", color: "#555555" },
  h: { name: "C", color: "#555555" }, cpp: { name: "C++", color: "#f34b7d" },
  cc: { name: "C++", color: "#f34b7d" }, cxx: { name: "C++", color: "#f34b7d" },
  hpp: { name: "C++", color: "#f34b7d" }, hh: { name: "C++", color: "#f34b7d" },
  cs: { name: "C#", color: "#178600" }, rb: { name: "Ruby", color: "#701516" },
  php: { name: "PHP", color: "#4F5D95" }, lua: { name: "Lua", color: "#000080" },
  luau: { name: "Luau", color: "#00A2FF" }, dart: { name: "Dart", color: "#00B4AB" },
  scala: { name: "Scala", color: "#c22d40" }, zig: { name: "Zig", color: "#ec915c" },
  sh: { name: "Shell", color: "#89e051" }, bash: { name: "Shell", color: "#89e051" },
  zsh: { name: "Shell", color: "#89e051" }, ps1: { name: "PowerShell", color: "#012456" },
  html: { name: "HTML", color: "#e34c26" }, htm: { name: "HTML", color: "#e34c26" },
  css: { name: "CSS", color: "#663399" }, scss: { name: "SCSS", color: "#c6538c" },
  sass: { name: "Sass", color: "#a53b70" }, less: { name: "Less", color: "#1d365d" },
  vue: { name: "Vue", color: "#41b883" }, svelte: { name: "Svelte", color: "#ff3e00" },
  sql: { name: "SQL", color: "#e38c00" }, glsl: { name: "GLSL", color: "#5686a5" },
  vert: { name: "GLSL", color: "#5686a5" }, frag: { name: "GLSL", color: "#5686a5" },
  wgsl: { name: "WGSL", color: "#1a5e9a" }, hlsl: { name: "HLSL", color: "#aace60" },
  shader: { name: "ShaderLab", color: "#222c37" }, gd: { name: "GDScript", color: "#355570" },
  ex: { name: "Elixir", color: "#6e4a7e" }, exs: { name: "Elixir", color: "#6e4a7e" },
  erl: { name: "Erlang", color: "#B83998" }, hs: { name: "Haskell", color: "#5e5086" },
  ml: { name: "OCaml", color: "#ef7a08" }, clj: { name: "Clojure", color: "#db5855" },
  r: { name: "R", color: "#198CE7" }, jl: { name: "Julia", color: "#a270ba" },
  nim: { name: "Nim", color: "#ffc200" }, asm: { name: "Assembly", color: "#6E4C13" },
  s: { name: "Assembly", color: "#6E4C13" }, cmake: { name: "CMake", color: "#DA3434" },
  dockerfile: { name: "Dockerfile", color: "#384d54" }, makefile: { name: "Makefile", color: "#427819" },
  nix: { name: "Nix", color: "#7e7eff" }, tf: { name: "HCL", color: "#844FBA" },
  m: { name: "Objective-C", color: "#438eff" }, mm: { name: "Objective-C++", color: "#6866fb" },
  fs: { name: "F#", color: "#b845fc" }, vb: { name: "Visual Basic .NET", color: "#945db7" },
};

const EXCLUDED = /(^|\/)(node_modules|vendor|vendors|third_party|thirdparty|dist|build|out|target|\.next|\.nuxt|coverage|bower_components|Pods|\.git)\/|\.min\.(js|css)$|(^|\/)(package-lock\.json|bun\.lockb?|yarn\.lock|pnpm-lock\.yaml)$/i;

export interface LanguageShare {
  name: string;
  color: string;
  bytes: number;
  percent: number;
}

export function languageFor(path: string): { name: string; color: string } | null {
  if (EXCLUDED.test(path)) return null;
  const base = path.slice(path.lastIndexOf("/") + 1);
  const lower = base.toLowerCase();
  if (lower === "dockerfile" || lower.startsWith("dockerfile.")) return LANGUAGES.dockerfile!;
  if (lower === "makefile" || lower === "gnumakefile") return LANGUAGES.makefile!;
  if (lower === "cmakelists.txt") return LANGUAGES.cmake!;
  const dot = lower.lastIndexOf(".");
  if (dot <= 0) return null;
  return LANGUAGES[lower.slice(dot + 1)] ?? null;
}

export function languageBreakdown(files: readonly TreeFile[]): LanguageShare[] {
  const totals = new Map<string, { color: string; bytes: number }>();
  let sum = 0;
  for (const file of files) {
    const language = languageFor(file.path);
    if (!language || file.size <= 0) continue;
    const entry = totals.get(language.name) ?? { color: language.color, bytes: 0 };
    entry.bytes += file.size;
    totals.set(language.name, entry);
    sum += file.size;
  }
  if (sum === 0) return [];
  const shares: LanguageShare[] = [];
  let other = 0;
  for (const [name, { color, bytes }] of [...totals].sort((a, b) => b[1].bytes - a[1].bytes)) {
    const percent = (bytes / sum) * 100;
    if (percent < 0.1) other += bytes;
    else shares.push({ name, color, bytes, percent: Math.round(percent * 10) / 10 });
  }
  if (other > 0) shares.push({ name: "Other", color: "#8b949e", bytes: other, percent: Math.round((other / sum) * 1000) / 10 });
  return shares;
}
