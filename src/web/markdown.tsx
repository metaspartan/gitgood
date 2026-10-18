import { Fragment, memo, type ReactNode } from "react";

export interface RenderMarkdownOptions {
  resolveImageUrl?: (src: string) => string | null;
  resolveReference?: (raw: string) => string | null;
  referenceMode?: boolean;
}

type Align = "left" | "right" | "center" | null;

type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "br" }
  | { t: "em" | "strong" | "del"; c: Inline[] }
  | { t: "link"; href: string; title?: string; c: Inline[] }
  | { t: "img"; src: string; alt: string; title?: string };

type Block =
  | { t: "p"; text: string }
  | { t: "h"; level: number; text: string }
  | { t: "code"; lang: string | null; v: string }
  | { t: "hr" }
  | { t: "quote"; c: Block[] }
  | { t: "list"; ordered: boolean; start: number; loose: boolean; items: { task: boolean | null; c: Block[] }[] }
  | { t: "table"; align: Align[]; head: string[]; rows: string[][] }
  | { t: "html"; v: string };

interface Definition {
  href: string;
  title?: string;
}

type Definitions = Map<string, Definition>;

interface Delim {
  t: "delim";
  ch: string;
  n: number;
  orig: number;
  open: boolean;
  close: boolean;
}

type Item = Inline | Delim;

const FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*(.*?)[ \t]*$/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const BULLET = /^( {0,3})([-+*])([ \t]+|$)(.*)$/;
const ORDERED = /^( {0,3})(\d{1,9})([.)])([ \t]+|$)(.*)$/;
const QUOTE = /^ {0,3}>[ ]?(.*)$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const HTML_BLOCK = /^ {0,3}(?:<!--|<\/?[A-Za-z][A-Za-z0-9-]*(?:[\s/>]|$))/;
const DEFINITION = /^ {0,3}\[((?:[^\]\\]|\\.)+)\]:[ \t]*(?:<([^>\n]*)>|(\S+))(?:[ \t]+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?[ \t]*$/;
const TABLE_DELIMITER = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const ASCII_PUNCTUATION = /^[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]$/;
const PUNCTUATION = /[\p{P}\p{S}]/u;
const WHITESPACE = /\s/;
const SAFE_PROTOCOL = /^(https?|ircs?|mailto|xmpp)$/i;
const REFERENCE = /(?<![\w/:#])(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#[1-9]\d*(?![\w])/g;
const MAX_DESTINATION = 4096;
const MAX_TITLE = 1024;
const MAX_DEPTH = 32;
const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: "\u00a0", copy: "\u00a9", reg: "\u00ae", trade: "\u2122",
  mdash: "\u2014", ndash: "\u2013", hellip: "\u2026", rarr: "\u2192", larr: "\u2190", uarr: "\u2191", darr: "\u2193",
  laquo: "\u00ab", raquo: "\u00bb", middot: "\u00b7", times: "\u00d7", check: "\u2713", deg: "\u00b0", euro: "\u20ac",
};

export function safeUrl(raw: string): string {
  const url = raw.replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, "").replace(/[\u0000-\u001f\u007f]/g, "").replace(/ /g, "%20");
  const colon = url.indexOf(":");
  const firstOf = (ch: string) => url.indexOf(ch);
  const before = (index: number) => index > -1 && colon > index;
  if (colon < 0 || before(firstOf("/")) || before(firstOf("?")) || before(firstOf("#")) || SAFE_PROTOCOL.test(url.slice(0, colon))) {
    return url;
  }
  return "";
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (match, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "\ufffd";
    }
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

function unescape(text: string): string {
  return decodeEntities(text.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "$1"));
}

function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

function expandTabs(line: string): string {
  return line.replace(/^[ \t]+/, (lead) => lead.replace(/\t/g, "    "));
}

function leadingSpaces(line: string): number {
  return line.length - line.trimStart().length;
}

function isBlank(line: string): boolean {
  return line.trim() === "";
}

function startsBlock(line: string): boolean {
  return FENCE.test(line) || ATX.test(line) || HR.test(line) || QUOTE.test(line) || BULLET.test(line) || /^ {0,3}1[.)]([ \t]|$)/.test(line);
}

function splitRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  const cells: string[] = [];
  let current = "";
  let inCode = false;
  for (let i = 0; i < row.length; i += 1) {
    const ch = row[i]!;
    if (ch === "\\" && row[i + 1] === "|") {
      current += "|";
      i += 1;
    } else if (ch === "`") {
      inCode = !inCode;
      current += ch;
    } else if (ch === "|" && !inCode) {
      cells.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

function parseList(lines: string[], start: number, defs: Definitions, depth: number): { block: Block; next: number } {
  const first = BULLET.exec(lines[start]!) ?? ORDERED.exec(lines[start]!)!;
  const ordered = !BULLET.test(lines[start]!);
  const marker = ordered ? first[3]! : first[2]!;
  const items: { task: boolean | null; c: Block[] }[] = [];
  let loose = false;
  let i = start;
  let previousEndedBlank = false;
  while (i < lines.length) {
    const match = ordered ? ORDERED.exec(lines[i]!) : BULLET.exec(lines[i]!);
    if (!match || (ordered ? match[3] : match[2]) !== marker || HR.test(lines[i]!)) break;
    if (previousEndedBlank) loose = true;
    const indent = match[1]!.length;
    const markerWidth = ordered ? match[2]!.length + 1 : 1;
    const spacing = (ordered ? match[4] : match[3])!.length;
    const rest = (ordered ? match[5] : match[4])!;
    let contentIndent = indent + markerWidth + (rest === "" || spacing > 4 ? 1 : spacing);
    const firstLine = spacing > 4 ? " ".repeat(spacing - 1) + rest : rest;
    if (rest === "" && spacing === 0) contentIndent = indent + markerWidth + 1;
    const body: string[] = [firstLine];
    i += 1;
    let sawBlank = false;
    let inFence = FENCE.test(firstLine);
    let blankBetweenBlocks = false;
    while (i < lines.length) {
      const line = lines[i]!;
      if (isBlank(line)) {
        body.push("");
        sawBlank = true;
        i += 1;
        continue;
      }
      if (leadingSpaces(line) >= contentIndent) {
        if (sawBlank && !inFence) blankBetweenBlocks = true;
        const content = line.slice(contentIndent);
        if (FENCE.test(content)) inFence = !inFence;
        body.push(content);
        sawBlank = false;
        i += 1;
        continue;
      }
      if (sawBlank) break;
      if (!startsBlock(line) && !ORDERED.test(line) && !isBlank(body[body.length - 1] ?? "")) {
        body.push(line.trimStart());
        i += 1;
        continue;
      }
      break;
    }
    let trailingBlank = false;
    while (body.length > 0 && body[body.length - 1] === "") {
      body.pop();
      trailingBlank = true;
    }
    previousEndedBlank = trailingBlank;
    let task: boolean | null = null;
    const taskMatch = /^\[([ xX])\][ \t]+/.exec(body[0] ?? "");
    if (taskMatch) {
      task = taskMatch[1] !== " ";
      body[0] = body[0]!.slice(taskMatch[0].length);
    }
    const children = parseBlocks(body, defs, depth + 1);
    if (blankBetweenBlocks && children.length > 1) loose = true;
    items.push({ task, c: children });
  }
  return { block: { t: "list", ordered, start: ordered ? Number.parseInt(first[2]!, 10) : 1, loose, items }, next: i };
}

function parseBlocks(input: string[], defs: Definitions, depth = 0): Block[] {
  if (depth > MAX_DEPTH) return [{ t: "p", text: input.join("\n").trim() }];
  const lines = input.map(expandTabs);
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence && !(fence[2]![0] === "`" && fence[3]!.includes("`"))) {
      const indent = fence[1]!.length;
      const closing = new RegExp(`^ {0,3}${fence[2]![0] === "`" ? "`" : "~"}{${fence[2]!.length},}[ \\t]*$`);
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !closing.test(lines[i]!)) {
        const raw = lines[i]!;
        body.push(raw.slice(Math.min(indent, leadingSpaces(raw))));
        i += 1;
      }
      i += 1;
      const lang = unescape(fence[3]!.split(/\s+/)[0] ?? "");
      out.push({ t: "code", lang: lang || null, v: body.length ? `${body.join("\n")}\n` : "" });
      continue;
    }
    const atx = ATX.exec(line);
    if (atx) {
      out.push({ t: "h", level: atx[1]!.length, text: (atx[2] ?? "").replace(/(^|[ \t]+)#+[ \t]*$/, "").trim() });
      i += 1;
      continue;
    }
    if (HR.test(line)) {
      out.push({ t: "hr" });
      i += 1;
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length) {
        const quoted = QUOTE.exec(lines[i]!);
        if (quoted) body.push(quoted[1]!);
        else if (!isBlank(lines[i]!) && !startsBlock(lines[i]!) && body.length > 0 && !isBlank(body[body.length - 1]!)) body.push(lines[i]!);
        else break;
        i += 1;
      }
      out.push({ t: "quote", c: parseBlocks(body, defs, depth + 1) });
      continue;
    }
    if (BULLET.test(line) || ORDERED.test(line)) {
      const { block, next } = parseList(lines, i, defs, depth);
      out.push(block);
      i = next;
      continue;
    }
    if (HTML_BLOCK.test(line)) {
      const body: string[] = [];
      const comment = /^ {0,3}<!--/.test(line);
      while (i < lines.length && (comment || !isBlank(lines[i]!))) {
        body.push(lines[i]!);
        i += 1;
        if (comment && body[body.length - 1]!.includes("-->")) break;
      }
      out.push({ t: "html", v: body.join("\n") });
      continue;
    }
    if (leadingSpaces(line) >= 4) {
      const body: string[] = [];
      while (i < lines.length && (isBlank(lines[i]!) || leadingSpaces(lines[i]!) >= 4)) {
        body.push(lines[i]!.slice(Math.min(4, leadingSpaces(lines[i]!))));
        i += 1;
      }
      while (body.length && isBlank(body[body.length - 1]!)) body.pop();
      out.push({ t: "code", lang: null, v: `${body.join("\n")}\n` });
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_DELIMITER.test(lines[i + 1]!)) {
      const head = splitRow(line);
      const delimiter = splitRow(lines[i + 1]!);
      if (head.length === delimiter.length) {
        const align: Align[] = delimiter.map((cell) => {
          const left = cell.startsWith(":");
          const right = cell.endsWith(":");
          return left && right ? "center" : right ? "right" : left ? "left" : null;
        });
        const rows: string[][] = [];
        i += 2;
        while (i < lines.length && !isBlank(lines[i]!) && !startsBlock(lines[i]!)) {
          const cells = splitRow(lines[i]!);
          rows.push(head.map((_, index) => cells[index] ?? ""));
          i += 1;
        }
        out.push({ t: "table", align, head, rows });
        continue;
      }
    }
    const definition = DEFINITION.exec(line);
    if (definition) {
      const key = normalizeLabel(definition[1]!);
      if (!defs.has(key)) {
        const title = definition[4] ?? definition[5] ?? definition[6];
        defs.set(key, { href: unescape(definition[2] ?? definition[3] ?? ""), ...(title !== undefined ? { title: unescape(title) } : {}) });
      }
      i += 1;
      continue;
    }
    const paragraph: string[] = [line.trimStart()];
    i += 1;
    let heading = 0;
    while (i < lines.length && !isBlank(lines[i]!)) {
      const setext = SETEXT.exec(lines[i]!);
      if (setext) {
        heading = setext[1]![0] === "=" ? 1 : 2;
        i += 1;
        break;
      }
      if (startsBlock(lines[i]!)) break;
      if (lines[i]!.includes("|") && i + 1 < lines.length && TABLE_DELIMITER.test(lines[i + 1]!)) break;
      paragraph.push(lines[i]!.trimStart());
      i += 1;
    }
    const text = paragraph.join("\n").replace(/[ \t]+$/, "");
    out.push(heading ? { t: "h", level: heading, text } : { t: "p", text });
  }
  return out;
}

function flanking(before: string, after: string): { left: boolean; right: boolean; beforePunct: boolean; afterPunct: boolean } {
  const beforeSpace = before === "" || WHITESPACE.test(before);
  const afterSpace = after === "" || WHITESPACE.test(after);
  const beforePunct = PUNCTUATION.test(before);
  const afterPunct = PUNCTUATION.test(after);
  return {
    left: !afterSpace && (!afterPunct || beforeSpace || beforePunct),
    right: !beforeSpace && (!beforePunct || afterSpace || afterPunct),
    beforePunct,
    afterPunct,
  };
}

function matchBrackets(text: string): Map<number, number> {
  const matches = new Map<number, number>();
  const stack: number[] = [];
  const unmatchedRuns = new Set<number>();
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\\") i += 1;
    else if (ch === "`") {
      let length = 1;
      while (text[i + length] === "`") length += 1;
      if (!unmatchedRuns.has(length)) {
        const run = "`".repeat(length);
        const end = text.indexOf(run, i + length);
        if (end > -1) i = end + length - 1;
        else {
          unmatchedRuns.add(length);
          i += length - 1;
        }
      } else {
        i += length - 1;
      }
    } else if (ch === "[") stack.push(i);
    else if (ch === "]" && stack.length) matches.set(stack.pop()!, i);
  }
  return matches;
}

function parseDestination(text: string, start: number): { href: string; title?: string; end: number } | null {
  let i = start;
  while (text[i] === " " || text[i] === "\n") i += 1;
  let href = "";
  if (text[i] === "<") {
    const close = text.indexOf(">", i);
    if (close < 0 || close - i > MAX_DESTINATION || text.slice(i, close).includes("\n")) return null;
    href = text.slice(i + 1, close);
    i = close + 1;
  } else {
    let depth = 0;
    const begin = i;
    const limit = Math.min(text.length, i + MAX_DESTINATION);
    while (i < limit) {
      const ch = text[i]!;
      if (ch === "\\" && i + 1 < text.length) {
        i += 2;
        continue;
      }
      if (/\s/.test(ch)) break;
      if (ch === "(") depth += 1;
      if (ch === ")") {
        if (depth === 0) break;
        depth -= 1;
      }
      i += 1;
    }
    href = text.slice(begin, i);
  }
  while (text[i] === " " || text[i] === "\n") i += 1;
  let title: string | undefined;
  const quote = text[i];
  if (quote === "\"" || quote === "'" || quote === "(") {
    const closer = quote === "(" ? ")" : quote;
    const end = text.indexOf(closer, i + 1);
    if (end < 0 || end - i > MAX_TITLE) return null;
    title = unescape(text.slice(i + 1, end));
    i = end + 1;
    while (text[i] === " " || text[i] === "\n") i += 1;
  }
  if (text[i] !== ")") return null;
  return { href: unescape(href), ...(title !== undefined ? { title } : {}), end: i + 1 };
}

function plainText(nodes: Inline[]): string {
  return nodes.map((node) => (node.t === "text" || node.t === "code" ? node.v : node.t === "br" ? " " : node.t === "img" ? node.alt : plainText(node.c))).join("");
}

function trimAutolink(url: string): string {
  let end = url.length;
  while (end > 0 && /[?!.,:*_~'"]/.test(url[end - 1]!)) end -= 1;
  let trimmed = url.slice(0, end);
  while (trimmed.endsWith(")") && (trimmed.match(/\(/g) ?? []).length < (trimmed.match(/\)/g) ?? []).length) trimmed = trimmed.slice(0, -1);
  return trimmed;
}

function parseInline(text: string, defs: Definitions, inLink = false): Inline[] {
  const items: Item[] = [];
  let buffer = "";
  const flush = (): void => {
    if (buffer) items.push({ t: "text", v: decodeEntities(buffer) });
    buffer = "";
  };
  const hasAt = text.includes("@");
  const brackets = matchBrackets(text);
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "\\") {
      const next = text[i + 1] ?? "";
      if (next === "\n") {
        flush();
        items.push({ t: "br" });
        i += 2;
      } else if (ASCII_PUNCTUATION.test(next)) {
        flush();
        items.push({ t: "text", v: next });
        i += 2;
      } else {
        buffer += ch;
        i += 1;
      }
      continue;
    }
    if (ch === "`") {
      const run = /^`+/.exec(text.slice(i))![0];
      let search = i + run.length;
      let close = -1;
      while (search < text.length) {
        const found = text.indexOf(run, search);
        if (found < 0) break;
        if (text[found + run.length] !== "`" && text[found - 1] !== "`") {
          close = found;
          break;
        }
        search = found + 1;
        while (text[search] === "`") search += 1;
      }
      if (close < 0) {
        buffer += run;
        i += run.length;
        continue;
      }
      let code = text.slice(i + run.length, close).replace(/\n/g, " ");
      if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim() !== "") code = code.slice(1, -1);
      flush();
      items.push({ t: "code", v: code });
      i = close + run.length;
      continue;
    }
    const isImage = ch === "!" && text[i + 1] === "[";
    if (isImage || (ch === "[" && !inLink)) {
      const open = isImage ? i + 1 : i;
      const close = brackets.get(open) ?? -1;
      if (close > -1) {
        const label = text.slice(open + 1, close);
        let target: { href: string; title?: string; end: number } | null = null;
        if (text[close + 1] === "(") target = parseDestination(text, close + 2);
        if (!target) {
          let key = label;
          let end = close + 1;
          if (text[close + 1] === "[") {
            const refClose = text.indexOf("]", close + 2);
            if (refClose > -1) {
              const ref = text.slice(close + 2, refClose);
              key = ref.trim() === "" ? label : ref;
              end = refClose + 1;
            }
          }
          const definition = defs.get(normalizeLabel(key));
          if (definition) target = { href: definition.href, ...(definition.title !== undefined ? { title: definition.title } : {}), end };
        }
        if (target) {
          flush();
          const children = parseInline(label, defs, true);
          if (isImage) items.push({ t: "img", src: target.href, alt: plainText(children), ...(target.title !== undefined ? { title: target.title } : {}) });
          else items.push({ t: "link", href: target.href, ...(target.title !== undefined ? { title: target.title } : {}), c: children });
          i = target.end;
          continue;
        }
      }
      buffer += isImage ? "![" : "[";
      i += isImage ? 2 : 1;
      continue;
    }
    if (ch === "<" && !inLink) {
      const rest = text.slice(i);
      const uri = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*)>/.exec(rest);
      const email = uri ? null : /^<([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/.exec(rest);
      if (uri || email) {
        flush();
        const value = (uri ?? email)![1]!;
        items.push({ t: "link", href: uri ? value : `mailto:${value}`, c: [{ t: "text", v: value }] });
        i += (uri ?? email)![0].length;
        continue;
      }
    }
    if (!inLink && (ch === "h" || ch === "w")) {
      const before = text[i - 1] ?? "";
      if (before === "" || /[\s(*_~]/.test(before)) {
        const match = /^(?:https?:\/\/|www\.)[^\s<]+/.exec(text.slice(i));
        if (match && (match[0].startsWith("http") || /^www\.[a-zA-Z0-9-]+\.[a-zA-Z0-9]/.test(match[0]))) {
          const url = trimAutolink(match[0]);
          if (url.length > (url.startsWith("www.") ? 4 : url.indexOf("//") + 2)) {
            flush();
            items.push({ t: "link", href: url.startsWith("www.") ? `http://${url}` : url, c: [{ t: "text", v: url }] });
            i += url.length;
            continue;
          }
        }
      }
    }
    if (ch === "*" || ch === "_" || ch === "~") {
      const run = new RegExp(`^\\${ch}+`).exec(text.slice(i))![0];
      const { left, right, beforePunct, afterPunct } = flanking(text[i - 1] ?? "", text[i + run.length] ?? "");
      flush();
      const open = ch === "_" ? left && (!right || beforePunct) : left;
      const close = ch === "_" ? right && (!left || afterPunct) : right;
      items.push({ t: "delim", ch, n: run.length, orig: run.length, open, close });
      i += run.length;
      continue;
    }
    if (ch === "\n") {
      if (/ {2,}$/.test(buffer)) {
        buffer = buffer.replace(/ +$/, "");
        flush();
        items.push({ t: "br" });
      } else {
        buffer = `${buffer.replace(/ +$/, "")}\n`;
      }
      i += 1;
      while (text[i] === " ") i += 1;
      continue;
    }
    if (hasAt && !inLink && /[A-Za-z0-9]/.test(ch) && !/[A-Za-z0-9._+-]/.test(text[i - 1] ?? "")) {
      const email = /^[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/.exec(text.slice(i, i + 320));
      if (email) {
        const address = email[0].replace(/\.+$/, "");
        if (!/[-_]$/.test(address) && address.includes(".", address.indexOf("@"))) {
          flush();
          items.push({ t: "link", href: `mailto:${address}`, c: [{ t: "text", v: address }] });
          i += address.length;
          continue;
        }
      }
    }
    buffer += ch;
    i += 1;
  }
  flush();
  return resolveEmphasis(items);
}

function finalize(items: Item[]): Inline[] {
  const out: Inline[] = [];
  for (const item of items) {
    const node: Inline = item.t === "delim" ? { t: "text", v: item.ch.repeat(item.n) } : item;
    const last = out[out.length - 1];
    if (node.t === "text" && last?.t === "text") out[out.length - 1] = { t: "text", v: last.v + node.v };
    else if (!(node.t === "text" && node.v === "")) out.push(node);
  }
  return out;
}

function resolveEmphasis(items: Item[]): Inline[] {
  const bottom = new Map<string, number>();
  let i = 0;
  while (i < items.length) {
    const closer = items[i]!;
    if (closer.t !== "delim" || !closer.close || closer.n === 0) {
      i += 1;
      continue;
    }
    let found = -1;
    const bottomKey = `${closer.ch}${closer.orig % 3}${closer.open ? 1 : 0}`;
    const floor = bottom.get(bottomKey) ?? -1;
    for (let j = i - 1; j > floor; j -= 1) {
      const opener = items[j]!;
      if (opener.t !== "delim" || opener.ch !== closer.ch || !opener.open || opener.n === 0) continue;
      if (closer.ch === "~") {
        if (opener.n !== closer.n || closer.n > 2) continue;
      } else if ((opener.close || closer.open) && (opener.orig + closer.orig) % 3 === 0 && !(opener.orig % 3 === 0 && closer.orig % 3 === 0)) {
        continue;
      }
      found = j;
      break;
    }
    if (found < 0) {
      bottom.set(bottomKey, i - 1);
      i += 1;
      continue;
    }
    const opener = items[found] as Delim;
    const use = closer.ch === "~" ? closer.n : opener.n >= 2 && closer.n >= 2 ? 2 : 1;
    const inner = items.splice(found + 1, i - found - 1);
    items.splice(found + 1, 0, { t: closer.ch === "~" ? "del" : use === 2 ? "strong" : "em", c: finalize(inner) });
    opener.n -= use;
    closer.n -= use;
    i = found + 2;
    if (opener.n === 0) {
      items.splice(found, 1);
      i -= 1;
    }
    if (closer.n === 0) items.splice(i, 1);
  }
  return finalize(items);
}

export function headingSlug(text: string): string {
  return text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
}

interface RenderContext {
  options: RenderMarkdownOptions;
  defs: Definitions;
  slugs: Map<string, number>;
}

function renderReferences(text: string, ctx: RenderContext, key: string): ReactNode {
  if (!ctx.options.referenceMode || !ctx.options.resolveReference || !text.includes("#")) return text;
  const parts: ReactNode[] = [];
  let offset = 0;
  for (const match of text.matchAll(REFERENCE)) {
    const url = ctx.options.resolveReference(match[0]);
    if (!url || !safeUrl(url)) continue;
    parts.push(text.slice(offset, match.index));
    parts.push(<a key={`${key}-r${match.index}`} href={safeUrl(url)} className="markdown-ref" rel="noreferrer">{match[0]}</a>);
    offset = match.index! + match[0].length;
  }
  if (parts.length === 0) return text;
  parts.push(text.slice(offset));
  return parts;
}

function resolveImage(src: string, ctx: RenderContext): string {
  if (ctx.options.resolveImageUrl && src && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(src)) return safeUrl(ctx.options.resolveImageUrl(src) ?? "");
  return safeUrl(src);
}

function renderInlines(nodes: Inline[], ctx: RenderContext, inLink: boolean, prefix: string): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${prefix}${index}`;
    switch (node.t) {
      case "text":
        return inLink ? node.v : <Fragment key={key}>{renderReferences(node.v, ctx, key)}</Fragment>;
      case "code":
        return <code key={key} className="markdown-inline-code">{node.v}</code>;
      case "br":
        return <br key={key} />;
      case "em":
        return <em key={key}>{renderInlines(node.c, ctx, inLink, `${key}-`)}</em>;
      case "strong":
        return <strong key={key}>{renderInlines(node.c, ctx, inLink, `${key}-`)}</strong>;
      case "del":
        return <del key={key}>{renderInlines(node.c, ctx, inLink, `${key}-`)}</del>;
      case "link": {
        const href = safeUrl(node.href);
        const children = renderInlines(node.c, ctx, true, `${key}-`);
        return href ? <a key={key} href={href} title={node.title} rel="noreferrer">{children}</a> : <span key={key} className="markdown-broken-link">{children}</span>;
      }
      case "img": {
        const src = resolveImage(node.src, ctx);
        return src ? <img key={key} src={src} alt={node.alt} title={node.title} loading="lazy" decoding="async" /> : <span key={key} className="markdown-alt">{node.alt}</span>;
      }
    }
  });
}

function inline(text: string, ctx: RenderContext, prefix: string): ReactNode[] {
  return renderInlines(parseInline(text, ctx.defs), ctx, false, prefix);
}

function renderBlocks(blocks: Block[], ctx: RenderContext, tight: boolean, prefix: string): ReactNode[] {
  return blocks.map((block, index) => {
    const key = `${prefix}${index}`;
    switch (block.t) {
      case "p":
        return tight ? <Fragment key={key}>{inline(block.text, ctx, `${key}-`)}</Fragment> : <p key={key}>{inline(block.text, ctx, `${key}-`)}</p>;
      case "h": {
        const nodes = parseInline(block.text, ctx.defs);
        const base = headingSlug(plainText(nodes));
        const seen = ctx.slugs.get(base) ?? 0;
        ctx.slugs.set(base, seen + 1);
        const id = `user-content-${seen ? `${base}-${seen}` : base}`;
        const Tag = `h${block.level}` as "h1";
        return <Tag key={key} id={id}>{renderInlines(nodes, ctx, false, `${key}-`)}</Tag>;
      }
      case "code":
        return (
          <pre key={key} className="markdown-pre">
            <code className={block.lang ? `language-${block.lang}` : "markdown-inline-code"}>{block.v}</code>
          </pre>
        );
      case "hr":
        return <hr key={key} />;
      case "html":
        return <Fragment key={key}>{block.v}</Fragment>;
      case "quote":
        return <blockquote key={key}>{renderBlocks(block.c, ctx, false, `${key}-`)}</blockquote>;
      case "list": {
        const hasTasks = block.items.some((item) => item.task !== null);
        const items = block.items.map((item, itemIndex) => {
          const itemKey = `${key}-${itemIndex}`;
          const content = renderBlocks(item.c, ctx, !block.loose, `${itemKey}-`);
          if (item.task === null) return <li key={itemKey}>{content}</li>;
          return (
            <li key={itemKey} className="task-list-item">
              <input type="checkbox" disabled defaultChecked={item.task} /> {content}
            </li>
          );
        });
        const className = hasTasks ? "contains-task-list" : undefined;
        return block.ordered ? (
          <ol key={key} start={block.start === 1 ? undefined : block.start} className={className}>{items}</ol>
        ) : (
          <ul key={key} className={className}>{items}</ul>
        );
      }
      case "table":
        return (
          <div key={key} className="markdown-table-scroll" role="region" aria-label="Markdown table" tabIndex={0}>
            <table>
              <thead>
                <tr>
                  {block.head.map((cell, cellIndex) => (
                    <th key={cellIndex} style={block.align[cellIndex] ? { textAlign: block.align[cellIndex]! } : undefined}>{inline(cell, ctx, `${key}-h${cellIndex}-`)}</th>
                  ))}
                </tr>
              </thead>
              {block.rows.length ? (
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {row.map((cell, cellIndex) => (
                        <td key={cellIndex} style={block.align[cellIndex] ? { textAlign: block.align[cellIndex]! } : undefined}>{inline(cell, ctx, `${key}-${rowIndex}-${cellIndex}-`)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              ) : null}
            </table>
          </div>
        );
    }
  });
}

export function parseMarkdown(source: string): { blocks: Block[]; defs: Definitions } {
  const defs: Definitions = new Map();
  const blocks = parseBlocks(source.replace(/\r\n?/g, "\n").replace(/\u0000/g, "\ufffd").split("\n"), defs);
  return { blocks, defs };
}

const MarkdownContent = memo(
  function MarkdownContent({ source, options }: { source: string; options: RenderMarkdownOptions }) {
    const { blocks, defs } = parseMarkdown(source);
    return <>{renderBlocks(blocks, { options, defs, slugs: new Map() }, false, "b")}</>;
  },
  (previous, next) =>
    previous.source === next.source &&
    previous.options.resolveImageUrl === next.options.resolveImageUrl &&
    previous.options.resolveReference === next.options.resolveReference &&
    previous.options.referenceMode === next.options.referenceMode,
);

export function renderMarkdown(source: string, options: RenderMarkdownOptions = {}): ReactNode {
  return <MarkdownContent source={source} options={options} />;
}
