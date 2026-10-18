export type TreeEntryType = "blob" | "tree" | "commit";

export interface GitBranch {
  name: string;
  sha: string;
  updatedAt: number;
}

export interface GitTag {
  name: string;
  sha: string;
}

export interface GitCommit {
  sha: string;
  shortSha: string;
  authorName: string;
  authorEmail: string;
  authoredAt: number;
  parents: string[];
  subject: string;
  body?: string;
}

export interface GitCommitDetail extends GitCommit {
  body: string;
  stats: GitDiffStat;
  files: GitFileChange[];
}

export interface GitTreeEntry {
  name: string;
  path: string;
  type: TreeEntryType;
  mode: string;
  sha: string;
  size: number;
}

export interface GitFileChange {
  path: string;
  additions: number;
  deletions: number;
  binary: boolean;
  status: "added" | "modified" | "deleted" | "renamed";
}

export interface GitDiffStat {
  additions: number;
  deletions: number;
  filesChanged: number;
}

export interface GitRefSnapshot {
  refs: Map<string, string>;
  head: string;
}
