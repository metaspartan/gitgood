import { escapeHtml } from "./escape.ts";

export type TokenKind =
  | "comment"
  | "string"
  | "number"
  | "keyword"
  | "type"
  | "literal"
  | "function"
  | "tag"
  | "attr"
  | "key"
  | "operator"
  | "plain";

interface LanguageSpec {
  keywords: ReadonlySet<string>;
  types: ReadonlySet<string>;
  literals: ReadonlySet<string>;
  line: string | null;
  block: readonly [string, string] | null;
  quotes: boolean;
  backtick: boolean;
  json: boolean;
  markup: boolean;
  shell: boolean;
}

function words(list: string): ReadonlySet<string> {
  return new Set(list.split(" "));
}

const TS_KEYWORDS = words(
  "abstract as async await break case catch class const continue declare default delete do else enum export extends " +
    "finally for from function get if implements import in instanceof interface let new of private protected public " +
    "readonly return satisfies set static super switch this throw try type typeof var void while with yield " +
    "namespace keyof infer asserts is override",
);
const TS_TYPES = words(
  "any bigint boolean never number object string symbol undefined unknown void Array Promise Readonly Record Partial " +
    "Map Set Date Error RegExp JSON Uint8Array ArrayBuffer Response Request Headers FormData Blob File",
);
const TS_LITERALS = words("true false null undefined NaN Infinity this");

const JS_KEYWORDS = words(
  "async await break case catch class const continue debugger default delete do else export extends finally for from " +
    "function get if implements import in instanceof let new of return set static super switch this throw try typeof " +
    "var void while with yield",
);

const PY_KEYWORDS = words(
  "and as assert async await break class continue def del elif else except finally for from global if import in is " +
    "lambda nonlocal not or pass raise return try while with yield match case",
);
const PY_TYPES = words("bool bytes dict float frozenset int list object set str tuple type None True False self cls");

const RUST_KEYWORDS = words(
  "as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut " +
    "pub ref return self Self static struct super trait type unsafe use where while",
);
const RUST_TYPES = words(
  "bool char f32 f64 i8 i16 i32 i64 i128 isize str String u8 u16 u32 u64 u128 usize Vec Option Result Box Rc Arc HashMap",
);
const RUST_LITERALS = words("true false None Some Ok Err");

const GO_KEYWORDS = words(
  "break case chan const continue default defer else fallthrough for func go goto if import interface map package " +
    "range return select struct switch type var",
);
const GO_TYPES = words(
  "bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr",
);
const GO_LITERALS = words("true false nil iota");

const C_KEYWORDS = words(
  "auto break case char const continue default do double else enum extern float for goto if inline int long register " +
    "restrict return short signed sizeof static struct switch typedef union unsigned void volatile while class namespace " +
    "public private protected virtual template typename new delete this using try catch throw nullptr constexpr",
);
const C_TYPES = words("bool size_t uint8_t uint16_t uint32_t uint64_t int8_t int16_t int32_t int64_t FILE string vector");

const JAVA_KEYWORDS = words(
  "abstract assert break case catch class const continue default do else enum extends final finally for goto if " +
    "implements import instanceof interface native new package private protected public return static strictfp super " +
    "switch synchronized this throw throws transient try volatile while var record sealed yield fun val suspend",
);
const JAVA_TYPES = words("boolean byte char double float int long short void String Integer Boolean Double Object List Map");

const SHELL_KEYWORDS = words(
  "if then else elif fi for while do done case esac function in return export local readonly declare set unset " +
  "source alias echo exit trap shift eval exec test",
);

const RUBY_KEYWORDS = words(
  "alias and begin break case class def defined do else elsif end ensure for if in module next not or redo rescue " +
    "retry return self super then undef unless until when while yield attr_accessor require require_relative puts",
);

const SQL_KEYWORDS = words(
  "select from where insert into values update delete set create table alter drop index view join left right inner " +
    "outer on group by having order limit offset distinct as and or not null primary key foreign references default " +
  "unique constraint cascade union all exists case when then else end returning with",
);

const CS_KEYWORDS = words(
  "abstract as async await base break case catch class const continue default delegate do else enum event explicit " +
    "extern finally fixed for foreach get if implicit in interface internal is lock namespace new operator out override " +
    "params private protected public readonly record ref return sealed set sizeof stackalloc static struct switch this " +
    "throw try typeof unchecked unsafe using var virtual void volatile where while yield",
);

const PLAIN: LanguageSpec = {
  keywords: new Set<string>(),
  types: new Set<string>(),
  literals: new Set<string>(),
  line: null,
  block: null,
  quotes: false,
  backtick: false,
  json: false,
  markup: false,
  shell: false,
};

function spec(overrides: Partial<LanguageSpec>): LanguageSpec {
  return { ...PLAIN, ...overrides };
}

export const LANGUAGES: Readonly<Record<string, LanguageSpec>> = {
  typescript: spec({ keywords: TS_KEYWORDS, types: TS_TYPES, literals: TS_LITERALS, line: "//", block: ["/*", "*/"], quotes: true, backtick: true }),
  javascript: spec({ keywords: JS_KEYWORDS, types: TS_TYPES, literals: TS_LITERALS, line: "//", block: ["/*", "*/"], quotes: true, backtick: true }),
  python: spec({ keywords: PY_KEYWORDS, types: PY_TYPES, literals: PY_TYPES, line: "#", block: null, quotes: true, backtick: false }),
  rust: spec({ keywords: RUST_KEYWORDS, types: RUST_TYPES, literals: RUST_LITERALS, line: "//", block: ["/*", "*/"], quotes: true, backtick: false }),
  go: spec({ keywords: GO_KEYWORDS, types: GO_TYPES, literals: GO_LITERALS, line: "//", block: ["/*", "*/"], quotes: true, backtick: true }),
  c: spec({ keywords: C_KEYWORDS, types: C_TYPES, literals: words("true false NULL nullptr"), line: "//", block: ["/*", "*/"], quotes: true, backtick: false }),
  cpp: spec({ keywords: C_KEYWORDS, types: C_TYPES, literals: words("true false NULL nullptr"), line: "//", block: ["/*", "*/"], quotes: true, backtick: false }),
  java: spec({ keywords: JAVA_KEYWORDS, types: JAVA_TYPES, literals: words("true false null"), line: "//", block: ["/*", "*/"], quotes: true, backtick: false }),
  csharp: spec({ keywords: CS_KEYWORDS, types: JAVA_TYPES, literals: words("true false null"), line: "//", block: ["/*", "*/"], quotes: true, backtick: false }),
  ruby: spec({ keywords: RUBY_KEYWORDS, types: new Set<string>(), literals: words("true false nil"), line: "#", block: null, quotes: true, backtick: false }),
  shell: spec({ keywords: SHELL_KEYWORDS, types: new Set<string>(), literals: new Set<string>(), line: "#", block: null, quotes: true, backtick: false, shell: true }),
  sql: spec({ keywords: SQL_KEYWORDS, types: new Set<string>(), literals: words("true false null"), line: "--", block: ["/*", "*/"], quotes: true, backtick: false }),
  json: spec({ json: true, literals: words("true false null"), quotes: true }),
  css: spec({ line: null, block: ["/*", "*/"], quotes: true }),
  html: spec({ markup: true, line: null, block: ["<!--", "-->"], quotes: true }),
  toml: spec({ line: "#", block: null, quotes: true, literals: words("true false") }),
  yaml: spec({ line: "#", block: null, quotes: true, literals: words("true false null yes no on off") }),
  markdown: spec({ line: null, block: null, quotes: false }),
  docker: spec({ keywords: words("FROM RUN CMD ENTRYPOINT COPY ADD WORKDIR ENV ARG EXPOSE VOLUME USER LABEL HEALTHCHECK SHELL ONBUILD STOPSIGNAL AS"), line: "#", block: null, quotes: true }),
  make: spec({ keywords: words("include define endef ifeq ifneq ifdef ifndef else endif export unexport override"), line: "#", block: null, quotes: true }),
  cmake: spec({ keywords: words("if else elseif endif function endfunction macro endmacro foreach endforeach set list project cmake_minimum_required add_executable add_library target_link_libraries include find_package message return"), line: "#", block: null, quotes: true }),
  lua: spec({ keywords: words("and break do else elseif end false for function goto if in local nil not or repeat return then true until while"), line: "--", block: ["--[[", "]]"], quotes: true }),
  perl: spec({ keywords: words("my our local sub use package require if else elsif unless while for foreach return last next die print"), line: "#", block: null, quotes: true, shell: true }),
  r: spec({ keywords: words("function if else for while repeat break next return TRUE FALSE NULL NA library require"), line: "#", block: null, quotes: true }),
  dart: spec({ keywords: words("abstract as assert async await break case catch class const continue default do else enum export extends final finally for if import in is late new null on return static super switch this throw try var void while with yield"), line: "//", block: ["/*", "*/"], quotes: true }),
  scala: spec({ keywords: words("abstract case catch class def do else extends final finally for implicit import lazy match new object override package private protected return sealed super this throw trait try type val var while with yield"), line: "//", block: ["/*", "*/"], quotes: true }),
  elixir: spec({ keywords: words("def defp defmodule defmacro defstruct do end fn if else unless case cond for with when and or not nil true false alias import require use raise rescue after try"), line: "#", block: null, quotes: true }),
  erlang: spec({ keywords: words("after begin case catch cond end fun if let of receive try when and or not xor bnot div rem band bor bxor bsl bsr"), line: "%", block: null, quotes: true }),
  haskell: spec({ keywords: words("case class data default deriving do else foreign if import in infix infixl infixr instance let module newtype of then type where"), line: "--", block: ["{-", "-}"], quotes: true }),
  clojure: spec({ keywords: words("def defn defmacro let fn if do loop recur when cond case ns require import try catch finally throw new set! quote var"), line: ";", block: null, quotes: true }),
  zig: spec({ keywords: words("const var fn pub export extern return if else while for switch break continue defer errdefer try catch unreachable and or not null true false struct enum union error test comptime inline asm"), line: "//", block: null, quotes: true }),
  diff: spec({}),
  text: spec({}),
};

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface CompiledLanguage {
  regex: RegExp;
  spec: LanguageSpec;
}

const compiled = new Map<string, CompiledLanguage>();

function compile(language: string): CompiledLanguage | null {
  const existing = compiled.get(language);
  if (existing) return existing;
  const languageSpec = LANGUAGES[language];
  if (!languageSpec) return null;

  const parts: string[] = [];
  if (languageSpec.block) {
    const [open, close] = languageSpec.block;
    parts.push(`(?<block>${escapeRegex(open)}[\\s\\S]*?(?:${escapeRegex(close)}|$))`);
  }
  if (languageSpec.line) {
    parts.push(`(?<line>${escapeRegex(languageSpec.line)}[^\\n]*)`);
  }
  if (languageSpec.json) {
    parts.push(`(?<key>"(?:\\\\.|[^"\\\\\\n])*")(?=\\s*:)`);
  }
  if (languageSpec.quotes) {
    parts.push(`(?<str>"(?:\\\\.|[^"\\\\\\n])*"|'(?:\\\\.|[^'\\\\\\n])*')`);
  }
  if (languageSpec.backtick) {
    parts.push("(?<tmpl>`(?:\\\\[\\s\\S]|[^\\\\`])*`)");
  }
  if (languageSpec.markup) {
    parts.push("(?<tag></?[A-Za-z][\\w:.-]*)");
    parts.push("(?<attr>\\b[A-Za-z_:][\\w:.-]*(?=\\s*=))");
    parts.push(`(?<str>"[^"]*"|'[^']*')`);
  }
  parts.push("(?<num>\\b\\d[\\d_]*(?:\\.[\\d_]+)?(?:[eE][+-]?\\d+)?\\b|\\b0[xX][0-9a-fA-F_]+\\b)");
  if (languageSpec.shell) {
    parts.push("(?<keyword>\\$\\{[^}]*\\}|\\$[A-Za-z_][\\w]*|--?[A-Za-z][\\w-]*)");
  }
  parts.push("(?<word>[A-Za-z_$][\\w$]*)");

  const result: CompiledLanguage = {
    regex: new RegExp(parts.join("|"), "g"),
    spec: languageSpec,
  };
  compiled.set(language, result);
  return result;
}

interface Token {
  kind: TokenKind;
  text: string;
}

function classifyWord(word: string, languageSpec: LanguageSpec): TokenKind {
  if (languageSpec.keywords.has(word)) return "keyword";
  if (languageSpec.literals.has(word)) return "literal";
  if (languageSpec.types.has(word)) return "type";
  return "plain";
}

function isCallish(code: string, afterIndex: number): boolean {
  for (let i = afterIndex; i < code.length && i < afterIndex + 2; i++) {
    const char = code[i];
    if (char === "(") return true;
    if (char === " " || char === "\t") continue;
    return false;
  }
  return false;
}

export function tokenize(code: string, language: string | null): Token[] {
  const lang = language ? compile(language) : null;
  if (!lang) return [{ kind: "plain", text: code }];

  const tokens: Token[] = [];
  const { regex, spec: languageSpec } = lang;
  regex.lastIndex = 0;

  let cursor = 0;
  for (;;) {
    const match = regex.exec(code);
    if (!match) break;
    const index = match.index;
    if (index > cursor) tokens.push({ kind: "plain", text: code.slice(cursor, index) });

    const groups = match.groups ?? {};
    if (groups.block !== undefined) {
      tokens.push({ kind: "comment", text: groups.block });
    } else if (groups.line !== undefined) {
      tokens.push({ kind: "comment", text: groups.line });
    } else if (groups.key !== undefined) {
      tokens.push({ kind: "key", text: groups.key });
    } else if (groups.str !== undefined) {
      tokens.push({ kind: "string", text: groups.str });
    } else if (groups.tmpl !== undefined) {
      tokens.push({ kind: "string", text: groups.tmpl });
    } else if (groups.tag !== undefined) {
      tokens.push({ kind: "tag", text: groups.tag });
    } else if (groups.attr !== undefined) {
      tokens.push({ kind: "attr", text: groups.attr });
    } else if (groups.num !== undefined) {
      tokens.push({ kind: "number", text: groups.num });
    } else if (groups.keyword !== undefined) {
      tokens.push({ kind: "keyword", text: groups.keyword });
    } else if (groups.word !== undefined) {
      const word = groups.word;
      const base = classifyWord(word, languageSpec);
      tokens.push({
        kind: base === "plain" && isCallish(code, index + word.length) ? "function" : base,
        text: word,
      });
    } else {
      tokens.push({ kind: "plain", text: match[0] });
    }
    cursor = index + match[0].length;
    if (match[0].length === 0) regex.lastIndex += 1;
  }
  if (cursor < code.length) tokens.push({ kind: "plain", text: code.slice(cursor) });
  return tokens;
}

const KIND_CLASS: Record<TokenKind, string> = {
  comment: "tok-comment",
  string: "tok-string",
  number: "tok-number",
  keyword: "tok-keyword",
  type: "tok-type",
  literal: "tok-literal",
  function: "tok-function",
  tag: "tok-tag",
  attr: "tok-attr",
  key: "tok-key",
  operator: "tok-operator",
  plain: "",
};

function tokensToLines(tokens: readonly Token[]): string[] {
  const lines: string[] = [];
  let current = "";
  let open: string | null = null;

  for (const token of tokens) {
    const className = KIND_CLASS[token.kind];
    const chunks = token.text.split("\n");
    for (let i = 0; i < chunks.length; i++) {
      if (i > 0) {
        if (open) {
          current += "</span>";
          open = null;
        }
        lines.push(current);
        current = "";
      }
      const chunk = chunks[i] ?? "";
      if (chunk.length === 0) continue;

      if (className.length === 0) {
        if (open) {
          current += "</span>";
          open = null;
        }
        current += escapeHtml(chunk);
        continue;
      }
      if (open !== className) {
        if (open) current += "</span>";
        current += `<span class="${className}">`;
        open = className;
      }
      current += escapeHtml(chunk);
    }
  }
  if (open) current += "</span>";
  lines.push(current);
  return lines;
}

export const HIGHLIGHT_LIMITS = {
  maxLines: 2000,
  maxBytes: 200_000,
} as const;

export interface HighlightedCode {
  lines: string[];
  highlighted: boolean;
  language: string | null;
}

export function highlightLines(
  code: string,
  language: string | null,
  limits: { maxLines?: number; maxBytes?: number } = {},
): HighlightedCode {
  const maxLines = limits.maxLines ?? HIGHLIGHT_LIMITS.maxLines;
  const maxBytes = limits.maxBytes ?? HIGHLIGHT_LIMITS.maxBytes;

  const lineCount = countLines(code);
  const languageSpec = language ? LANGUAGES[language] : undefined;
  const hasRules =
    languageSpec !== undefined &&
    (languageSpec.keywords.size > 0 ||
      languageSpec.line !== null ||
      languageSpec.block !== null ||
      languageSpec.quotes ||
      languageSpec.backtick ||
      languageSpec.json ||
      languageSpec.markup ||
      languageSpec.shell);
  const supported = language !== null && hasRules;

  if (!supported || lineCount > maxLines || code.length > maxBytes) {
    return {
      lines: code.split("\n").map((line) => escapeHtml(line)),
      highlighted: false,
      language: supported ? language : null,
    };
  }

  return { lines: tokensToLines(tokenize(code, language)), highlighted: true, language };
}

function countLines(code: string): number {
  let count = 1;
  for (let i = 0; i < code.length; i++) {
    if (code.charCodeAt(i) === 10) count += 1;
  }
  return count;
}

export function highlightToHtml(code: string, language: string | null): string {
  return highlightLines(code, language).lines.join("\n");
}
