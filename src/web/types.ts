export interface User {
  id: number;
  username: string;
  display_name: string;
  avatar_hue: number;
  is_admin: boolean;
  created_at: number;
  email?: string;
  repo_count?: number;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  full_name: string;
  description: string;
  visibility: "public" | "private";
  default_branch: string;
  lfs_enabled: boolean;
  actions_enabled?: boolean;
  archived: boolean;
  created_at: number;
  updated_at: number;
  clone_url: string;
  openIssues?: number;
  openPulls?: number;
  lfsObjects?: number;
  lfsBytes?: number;
  stats?: RepoStats;
  permissions?: { read: boolean; write: boolean };
}

export interface RepoStats {
  openIssues: number;
  openPulls: number;
  branches: number;
  tags: number;
  commits: number;
  sizeBytes: number;
  lfsObjects?: number;
  lfsBytes?: number;
  stars?: number;
  forks?: number;
}

export interface Branch {
  name: string;
  sha: string;
  updated_at: number;
}

export interface Tag {
  name: string;
  sha: string;
}

export interface Commit {
  sha: string;
  short_sha: string;
  message: string;
  author: { name: string; email: string };
  authored_at: number;
  parents: string[];
  body?: string;
  stats?: { additions: number; deletions: number; filesChanged: number };
  files?: FileChange[];
}

export interface FileChange {
  path: string;
  additions: number;
  deletions: number;
  binary: boolean;
  status: "added" | "modified" | "deleted" | "renamed";
}

export interface TreeEntry {
  name: string;
  path: string;
  type: "blob" | "tree" | "commit";
  mode: string;
  sha: string;
  size: number;
}

export interface Blob {
  path: string;
  ref: string;
  size: number;
  truncated: boolean;
  binary: boolean;
  encoding: string;
  content: string | null;
  kind: "text" | "image" | "audio" | "video" | "model" | "binary";
  mime: string;
  language: string | null;
  line_count: number;
}

export interface DiffLine {
  kind: "context" | "add" | "del";
  text: string;
  old_line: number | null;
  new_line: number | null;
}

export interface DiffHunk {
  header: string;
  old_start: number;
  new_start: number;
  lines: DiffLine[];
}

export interface DiffFile {
  path: string;
  old_path: string | null;
  status: "added" | "modified" | "deleted" | "renamed";
  binary: boolean;
  additions: number;
  deletions: number;
  omitted: "binary" | "too_large" | null;
  language: string | null;
  hunks: DiffHunk[];
}

export interface DiffResult {
  files: DiffFile[];
  additions: number;
  deletions: number;
  truncated: boolean;
  base?: string;
  head?: string;
  files_changed?: number;
}

export interface BlameLine {
  line: number;
  sha: string;
  short_sha: string;
  author: string;
  authored_at: number;
  original_line: number;
  group: number;
  text: string;
}

export interface BlameResult {
  lines: BlameLine[];
  total_lines: number;
  truncated: boolean;
  path?: string;
  ref?: string;
  language?: string | null;
}

export interface Readme {
  path: string | null;
  ref: string;
  format: string | null;
  content: string | null;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body?: string;
  body_preview?: string;
  body_truncated?: boolean;
  state: "open" | "closed";
  created_at: number;
  updated_at: number;
  closed_at: number | null;
  milestone_id: number | null;
  assignees?: Assignee[];
  author?: User;
  comment_count?: number;
  labels?: string[];
  repository?: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body?: string;
  body_preview?: string;
  body_truncated?: boolean;
  state: "open" | "closed" | "merged";
  head: string;
  base: string;
  merged_sha: string | null;
  created_at: number;
  updated_at: number;
  merged_at: number | null;
  milestone_id: number | null;
  assignees?: Assignee[];
  author?: User;
  comment_count?: number;
  repository?: string;
}

export interface Comment {
  id: number;
  body: string;
  created_at: number;
  author?: User;
}

export interface Envelope<T> {
  items: T[];
  page: number;
  per_page: number;
  total: number;
  total_pages: number;
}

export interface SearchResults {
  query: string;
  repos: Repo[];
  issues: Issue[];
  pulls: Pull[];
}

export interface CodeHit {
  repository: string;
  path: string;
  language: string;
  snippet: string;
}

export interface CodeSearchResults {
  query: string;
  items: CodeHit[];
  truncated_index: boolean;
  at_result_limit: boolean;
}

export interface Webhook {
  id: number;
  url: string;
  events: string[];
  active: boolean;
  created_at: number;
  delivery_count?: number;
  last_status?: number | null;
  last_error?: string | null;
  last_at?: number | null;
}

export interface WebhookDelivery {
  id: number;
  event: string;
  status_code: number | null;
  error: string | null;
  attempts: number;
  duration_ms: number;
  created_at: number;
}

export interface AccessToken {
  id: number;
  name: string;
  scopes: string[];
  repo_id: number | null;
  repository: string | null;
  last_used_at: number | null;
  created_at: number;
  token?: string;
}

export interface Org {
  id: number;
  name: string;
  display_name: string;
  description: string;
  avatar_hue: number;
  created_at: number;
  updated_at: number;
  repo_count?: number;
  member_count?: number;
  viewer_role?: "owner" | "admin" | "member" | null;
  viewer_can_administer?: boolean;
}

export interface OrgMember {
  user: Pick<User, "id" | "username" | "display_name" | "avatar_hue">;
  role: "owner" | "admin" | "member";
  created_at: number;
}

export interface Notification {
  id: number;
  kind: string;
  repository: string | null;
  subject: {
    type: string;
    id: number | null;
    number: number | null;
    title: string;
  } | null;
  actor: string | null;
  unread: boolean;
  created_at: number;
  updated_at: number;
}

export interface SshKey {
  id: number;
  title: string;
  algorithm: string;
  fingerprint: string;
  created_at: number;
}

export interface PushPolicy {
  deny_non_fast_forwards: boolean;
  deny_deletes: boolean;
  fsck_objects: boolean;
  defaults: {
    denyNonFastForwards: boolean;
    denyDeletes: boolean;
    fsckObjects: boolean;
  };
  differs_from_default: boolean;
}

export interface Assignee {
  id: number;
  username: string;
  display_name: string;
  avatar_hue: number;
  assigned_at: number;
}

export interface Milestone {
  id: number;
  number: number;
  title: string;
  description: string;
  state: "open" | "closed";
  due_on: number | null;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
  creator: { id: number; username: string };
  open_issues: number;
  closed_issues: number;
  open_pulls: number;
  merged_pulls: number;
  closed_pulls: number;
  open_count: number;
  closed_count: number;
  total_count: number;
  completion_percent: number;
}

export interface MilestoneItems {
  issues: Array<{ id: number; number: number; title: string; state: string }>;
  pulls: Array<{ id: number; number: number; title: string; state: string }>;
  total: number;
}

export interface ThreadEvent {
  id: number;
  target_type: "issue" | "pull";
  kind: string;
  detail: Record<string, unknown>;
  created_at: number;
  actor: { id: number | null; username: string; display_name: string | null } | null;
}

export interface TopicsResponse {
  topics: string[];
  topics_csv: string;
  max_topics: number;
}

export interface QuotaInfo {
  used_bytes: number;
  limit_bytes: number | null;
  over_quota: boolean;
  percent_used: number | null;
}

export interface Collaborator {
  user_id: number;
  username: string;
  display_name: string;
  avatar_hue: number;
  permission: "read" | "write";
  created_at: number;
}

export interface CollaboratorsResponse {
  items: Collaborator[];
  can_manage: boolean;
}

export interface SocialState {
  watching: boolean;
  watch_level?: WatchLevel;
  starring: boolean;
  stars: number;
  watchers?: number;
  forks?: number;
}

export type WatchLevel = "participating" | "all" | "ignore";

export interface RepoPerson {
  username: string;
  display_name: string;
  avatar_hue: number;
  starred_at?: number;
  since?: number;
}

export interface ForkParent {
  parent: Repo | null;
}
export interface CiRun {
  id: number;
  repo_id: number;
  workflow_name: string;
  job_id: string;
  ref_name: string;
  sha: string;
  status: "queued" | "running" | "success" | "failure";
  exit_code: number | null;
  started_at: number;
  finished_at: number | null;
}

export interface CiRunnerInfo {
  active?: number;
  queued?: number;
  maxConcurrent?: number;
  maxPending?: number;
  mode: "disabled" | "trusted-host" | "runner";
  enabled: boolean;
  isolation: "none" | "external";
  runnersOnline?: number | null;
  notice: string;
}

export interface CiLogLine {
  seq: number;
  text: string;
}

export interface MfaState {
  totp_enabled: boolean;
  totp_pending: boolean;
  recovery_codes_remaining: number;
  passkeys: Array<{ id: number; label: string; created_at: number; last_used_at: number | null }>;
}

export interface AccountSettings {
  user: User;
  bootstrap_pending: boolean;
  instance_bootstrap_pending: boolean;
}

export type LoginResult = { user: User; mfa_required?: undefined } | { mfa_required: true; methods: string[] };

export interface PasskeyChallenge {
  challenge: string;
  rp: { name: string; id: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: Array<{ type: string; alg: number }>;
  timeout: number;
  attestation: string;
  authenticatorSelection: { residentKey: string; userVerification: string };
  label: string;
}

export interface ContentsCommit {
  commit: string;
  branch: string;
  path: string;
}

export interface ReleaseAsset {
  id: number;
  name: string;
  size: number;
  content_type: string;
  downloads: number;
}

export interface Release {
  id: number;
  tag_name: string;
  name: string;
  body: string;
  prerelease: boolean;
  draft: boolean;
  author: string;
  created_at: number;
  updated_at: number;
  assets: ReleaseAsset[];
}
