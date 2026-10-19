export interface DiffLine {
  kind: "context" | "add" | "del";
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export type DiffFileStatus = "added" | "modified" | "deleted" | "renamed";

export interface DiffFile {
  path: string;
  oldPath: string | null;
  status: DiffFileStatus;
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  omitted?: "binary" | "too_large";
}

export interface DiffResult {
  files: DiffFile[];
  additions: number;
  deletions: number;
  truncated: boolean;
}

export const DIFF_LIMITS = {
  maxFiles: 300,
  maxHunkLinesPerFile: 4000,
  maxTotalLines: 40_000,
} as const;

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const FILE_HEADER = /^diff --git a\/(.+) b\/(.+)$/;

export interface ParseDiffOptions {
  maxFiles?: number;
  maxHunkLinesPerFile?: number;
  maxTotalLines?: number;
}

export function parseUnifiedDiff(output: string, options: ParseDiffOptions = {}): DiffResult {
  const maxFiles = options.maxFiles ?? DIFF_LIMITS.maxFiles;
  const maxHunkLinesPerFile = options.maxHunkLinesPerFile ?? DIFF_LIMITS.maxHunkLinesPerFile;
  const maxTotalLines = options.maxTotalLines ?? DIFF_LIMITS.maxTotalLines;

  const files: DiffFile[] = [];
  let totalLines = 0;
  let truncated = false;

  let current: DiffFile | null = null;
  let currentHunk: DiffHunk | null = null;
  let oldCursor = 0;
  let newCursor = 0;
  let fileLines = 0;

  const closeHunk = (): void => {
    if (current && currentHunk) {
      current.hunks.push(currentHunk);
      currentHunk = null;
    }
  };

  const closeFile = (): void => {
    closeHunk();
    if (current) files.push(current);
    current = null;
    fileLines = 0;
  };

  for (const line of output.split("\n")) {
    if (line.startsWith("diff --git ")) {
      closeFile();
      const match = FILE_HEADER.exec(line);
      current = {
        path: match?.[2] ?? "",
        oldPath: match?.[1] ?? null,
        status: "modified",
        binary: false,
        additions: 0,
        deletions: 0,
        hunks: [],
      };
      continue;
    }

    if (!current) continue;

    if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      current.binary = true;
      current.omitted = "binary";
      continue;
    }
    if (line.startsWith("rename from ")) {
      current.oldPath = line.slice("rename from ".length);
      current.status = "renamed";
      continue;
    }
    if (line.startsWith("rename to ")) {
      current.path = line.slice("rename to ".length);
      current.status = "renamed";
      continue;
    }
    if (line.startsWith("new file mode")) {
      current.status = "added";
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      current.status = "deleted";
      continue;
    }
    if (line.startsWith("--- ")) {
      const candidate = line.slice(4).trim();
      if (candidate && candidate !== "/dev/null") {
        current.oldPath = candidate.replace(/^a\//, "");
        if (current.status !== "renamed") current.status = "modified";
      } else if (candidate === "/dev/null") {
        current.status = "added";
      }
      continue;
    }
    if (line.startsWith("+++ ")) {
      const candidate = line.slice(4).trim();
      if (candidate === "/dev/null") current.status = "deleted";
      continue;
    }

    const hunkHeader = HUNK_HEADER.exec(line);
    if (hunkHeader) {
      closeHunk();
      currentHunk = {
        header: line,
        oldStart: Number.parseInt(hunkHeader[1] ?? "0", 10),
        newStart: Number.parseInt(hunkHeader[2] ?? "0", 10),
        lines: [],
      };
      oldCursor = currentHunk.oldStart;
      newCursor = currentHunk.newStart;
      continue;
    }

    if (!currentHunk) continue;

    const marker = line[0];
    if (marker === "+") {
      currentHunk.lines.push({
        kind: "add",
        text: line.slice(1),
        oldLine: null,
        newLine: newCursor,
      });
      newCursor += 1;
      current.additions += 1;
    } else if (marker === "-") {
      currentHunk.lines.push({
        kind: "del",
        text: line.slice(1),
        oldLine: oldCursor,
        newLine: null,
      });
      oldCursor += 1;
      current.deletions += 1;
    } else if (marker === " ") {
      currentHunk.lines.push({
        kind: "context",
        text: line.slice(1),
        oldLine: oldCursor,
        newLine: newCursor,
      });
      oldCursor += 1;
      newCursor += 1;
    } else {
      continue;
    }

    fileLines += 1;
    totalLines += 1;

    if (fileLines === maxHunkLinesPerFile) {
      truncated = true;
      current.omitted = "too_large";
      closeFile();
      if (files.length >= maxFiles) break;
      continue;
    }
    if (totalLines === maxTotalLines) {
      truncated = true;
      closeFile();
      break;
    }
  }

  if (current) closeFile();

  return {
    files,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    truncated,
  };
}

export interface BlameLine {
  line: number;
  sha: string;
  shortSha: string;
  authorName: string;
  authoredAt: number;
  originalLine: number;
  group: number;
  text: string;
}

export interface BlameResult {
  lines: BlameLine[];
  totalLines: number;
  truncated: boolean;
}

export interface PatchFileMeta {
  path: string;
  oldPath: string | null;
  status: DiffFileStatus;
  binary: boolean;
  additions: number;
  deletions: number;
}

export function mergePatchMetadata(
  files: readonly PatchFileMeta[],
  parsed: DiffResult,
  truncated: boolean,
): DiffResult {
  const parsedByPath = new Map(parsed.files.map((file) => [file.path, file]));

  const merged: DiffFile[] = files.map((meta) => {
    const content = parsedByPath.get(meta.path);
    const file: DiffFile = {
      path: meta.path,
      oldPath: meta.oldPath,
      status: meta.status,
      binary: meta.binary,
      additions: meta.additions,
      deletions: meta.deletions,
      hunks: content?.hunks ?? [],
    };
    if (meta.binary) file.omitted = "binary";
    else if (content?.omitted) file.omitted = content.omitted;
    return file;
  });

  return {
    files: merged,
    additions: merged.reduce((sum, file) => sum + file.additions, 0),
    deletions: merged.reduce((sum, file) => sum + file.deletions, 0),
    truncated: truncated || parsed.truncated,
  };
}

export const BLAME_MAX_LINES = 5000;

const SHA_HEADER = /^([0-9a-f]{40}|[0-9a-f]{64}) \d+ \d+(?: \d+)?$/;

export function parseBlamePorcelain(output: string, maxLines = BLAME_MAX_LINES): BlameResult {
  const lines: BlameLine[] = [];
  let truncated = false;

  let sha = "";
  let authorName = "";
  let authoredAt = 0;
  let originalLine = 0;
  let lineNumber = 0;
  let group = -1;
  let previousKey = "";

  for (const raw of output.split("\n")) {
    if (raw.length === 0) continue;

    const header = SHA_HEADER.exec(raw);
    if (header) {
      sha = header[1] ?? "";
      const parts = raw.split(" ");
      originalLine = Number.parseInt(parts[1] ?? "0", 10);
      lineNumber = Number.parseInt(parts[2] ?? "0", 10);
      const key = `${sha}\u0000${authorName}`;
      if (key !== previousKey) {
        group += 1;
        previousKey = key;
      }
      continue;
    }

    if (raw.startsWith("\t")) {
      if (lines.length >= maxLines) {
        truncated = true;
        break;
      }
      lines.push({
        line: lineNumber,
        sha,
        shortSha: sha.slice(0, 8),
        authorName,
        authoredAt,
        originalLine,
        group,
        text: raw.slice(1),
      });
      continue;
    }

    if (raw.startsWith("author ")) {
      authorName = raw.slice("author ".length);
      continue;
    }
    if (raw.startsWith("author-time ")) {
      authoredAt = (Number.parseInt(raw.slice("author-time ".length), 10) || 0) * 1000;
      continue;
    }
  }

  return { lines, totalLines: lineNumber, truncated };
}
