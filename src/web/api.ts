import type {
  AccessToken,
  BlameResult,
  Blob,
  AccountSettings,
  Branch,
  CiLogLine,
  CiRun,
  CiRunnerInfo,
  ContentsCommit,
  Release,
  ReleaseAsset,
  LoginResult,
  MfaState,
  PasskeyChallenge,
  Commit,
  Comment,
  DiffResult,
  Envelope,
  ForkParent,
  Issue,
  Notification,
  Org,
  OrgMember,
  Pull,
  PushPolicy,
  QuotaInfo,
  TopicsResponse,
  CollaboratorsResponse,
  ThreadEvent,
  Assignee,
  Milestone,
  MilestoneItems,
  Readme,
  Repo,
  SearchResults,
  SocialState,
  SshKey,
  Tag,
  TreeEntry,
  User,
  Webhook,
  WebhookDelivery,
  RepoPerson,
  WatchLevel,
} from "./types.ts";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

interface ErrorPayload {
  error?: { code?: string; message?: string };
}

const inFlightReads = new Map<string, Promise<unknown>>();

function isPlainRead(init: RequestInit): boolean {
  return (init.method ?? "GET").toUpperCase() === "GET";
}

export function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!isPlainRead(init)) return fetchJson<T>(path, init);
  const existing = inFlightReads.get(path);
  if (existing) return existing as Promise<T>;
  const pending = fetchJson<T>(path, init);
  inFlightReads.set(path, pending);
  const clear = (): void => {
    if (inFlightReads.get(path) === pending) inFlightReads.delete(path);
  };
  pending.then(clear, clear);
  return pending;
}

async function fetchJson<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let payload: unknown = null;
  if (text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const shaped = (payload ?? {}) as ErrorPayload;
    throw new ApiError(
      response.status,
      shaped.error?.code ?? "error",
      shaped.error?.message ?? `Request failed with status ${response.status}`,
    );
  }
  return payload as T;
}


const post = <T>(path: string, body: unknown): Promise<T> =>
  request<T>(path, { method: "POST", body: JSON.stringify(body) });
const patch = <T>(path: string, body: unknown): Promise<T> =>
  request<T>(path, { method: "PATCH", body: JSON.stringify(body) });
const put = <T>(path: string, body: unknown): Promise<T> =>
  request<T>(path, { method: "PUT", body: JSON.stringify(body) });
const del = <T>(path: string): Promise<T> => request<T>(path, { method: "DELETE" });

export function splitRepoFullName(full: string): { owner: string; name: string } | null {
  const slash = full.indexOf("/");
  if (slash <= 0 || slash === full.length - 1) return null;
  return { owner: full.slice(0, slash), name: full.slice(slash + 1) };
}

function encodeRepo(owner: string, name: string): string {
  return `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

export const api = {
  backups: (signal?: AbortSignal) => request<{ configuration: { signup: boolean; repositoryCreation: boolean; secureCookies: boolean; sshConfigured: boolean; privateWebhooks: boolean; maxRepoBytes: number; maxLfsBytes: number; maxBodyBytes: number; gitConcurrency: number; requestLimit: number; requestWindowMs: number; indexFiles: number; indexFileBytes: number }; destinations: Array<{ id: string; name: string; kind: "local" | "nas" | "google-drive" }>; jobs: Array<{ id: string; destination: string; state: "running" | "completed" | "failed"; started: number; finished: number | null }>; active: boolean }>("/api/admin/backups", { signal }),
  startBackup: (destination: string) => post<{ id: string }>("/api/admin/backups", { destination }),
  me: () => request<{ user: User | null }>("/api/auth/me"),
  login: (username: string, password: string) =>
    post<LoginResult>("/api/auth/login", { username, password }),
  signup: (username: string, email: string, password: string) =>
    post<{ user: User }>("/api/auth/signup", { username, email, password }),
  logout: () => post<{ ok: boolean }>("/api/auth/logout", {}),

  tokens: () => request<{ items: AccessToken[] }>("/api/tokens"),
  createToken: (name: string, options: { scopes?: string[]; repository?: string } = {}) =>
    post<AccessToken>("/api/tokens", {
      name,
      ...(options.scopes && options.scopes.length > 0 ? { scopes: options.scopes } : {}),
      ...(options.repository ? { repository: options.repository } : {}),
    }),
  tokenRepositories: (owner: string) =>
    request<{ items: Array<{ full_name: string }> }>(
      `/api/users/${encodeURIComponent(owner)}/repos?per_page=100`,
    ),
  revokeToken: (id: number) => request<{ ok: boolean }>(`/api/tokens/${id}`, { method: "DELETE" }),

  repos: (options: { page?: number; perPage?: number } = {}) => {
    const params = new URLSearchParams();
    if (options.page && options.page > 1) params.set("page", String(options.page));
    if (options.perPage) params.set("per_page", String(options.perPage));
    const query = params.toString();
    return request<Envelope<Repo>>(`/api/repos${query ? `?${query}` : ""}`);
  },
  createRepo: (input: {
    name: string;
    description?: string;
    visibility?: string;
    default_branch?: string;
    lfs_enabled?: boolean;
    organization?: string;
  }) => post<Repo>("/api/repos", input),
  repo: (owner: string, name: string) => request<Repo>(encodeRepo(owner, name)),
  updateRepo: (owner: string, name: string, input: Record<string, unknown>) =>
    patch<Repo>(encodeRepo(owner, name), input),
  deleteRepo: (owner: string, name: string) =>
    request<{ ok: boolean }>(encodeRepo(owner, name), { method: "DELETE" }),

  branches: (owner: string, name: string) =>
    request<{ items: Branch[]; default_branch: string; head: string }>(`${encodeRepo(owner, name)}/branches`),
  tags: (owner: string, name: string) => request<{ items: Tag[] }>(`${encodeRepo(owner, name)}/tags`),
  commits: (owner: string, name: string, params: { ref?: string; path?: string; page?: number; perPage?: number } = {}) => {
    const query = new URLSearchParams();
    if (params.ref) query.set("ref", params.ref);
    if (params.path) query.set("path", params.path);
    if (params.page) query.set("page", String(params.page));
    if (params.perPage) query.set("per_page", String(params.perPage));
    return request<{ items: Commit[]; has_more: boolean; page: number; per_page: number; ref: string }>(
      `${encodeRepo(owner, name)}/commits?${query.toString()}`,
    );
  },
  commit: (owner: string, name: string, sha: string) =>
    request<Commit>(`${encodeRepo(owner, name)}/commits/${encodeURIComponent(sha)}`),
  tree: (owner: string, name: string, params: { ref?: string; path?: string } = {}) => {
    const query = new URLSearchParams();
    if (params.ref) query.set("ref", params.ref);
    if (params.path) query.set("path", params.path);
    return request<{ ref: string; path: string; items: TreeEntry[] }>(
      `${encodeRepo(owner, name)}/tree?${query.toString()}`,
    );
  },
  blob: (owner: string, name: string, params: { ref?: string; path: string }) => {
    const query = new URLSearchParams({ path: params.path });
    if (params.ref) query.set("ref", params.ref);
    return request<Blob>(`${encodeRepo(owner, name)}/blob?${query.toString()}`);
  },
  commitDiff: (owner: string, name: string, sha: string, path?: string) =>
    request<DiffResult>(
      `${encodeRepo(owner, name)}/commits/${encodeURIComponent(sha)}/diff${
        path ? `?path=${encodeURIComponent(path)}` : ""
      }`,
    ),
  diff: (owner: string, name: string, base: string, head: string, path?: string) => {
    const query = new URLSearchParams({ base, head });
    if (path) query.set("path", path);
    return request<DiffResult>(`${encodeRepo(owner, name)}/diff?${query.toString()}`);
  },
  blame: (owner: string, name: string, params: { ref?: string; path: string }) => {
    const query = new URLSearchParams({ path: params.path });
    if (params.ref) query.set("ref", params.ref);
    return request<BlameResult>(`${encodeRepo(owner, name)}/blame?${query.toString()}`);
  },
  archiveUrl: (owner: string, name: string, params: { ref?: string; format?: "tar.gz" | "zip"; path?: string }) => {
    const query = new URLSearchParams({ format: params.format ?? "tar.gz" });
    if (params.ref) query.set("ref", params.ref);
    if (params.path) query.set("path", params.path);
    return `${encodeRepo(owner, name)}/archive?${query.toString()}`;
  },

  rawUrl: (owner: string, name: string, params: { ref?: string; path: string; download?: boolean }) => {
    const query = new URLSearchParams({ path: params.path });
    if (params.ref) query.set("ref", params.ref);
    if (params.download) query.set("download", "1");
    return `${encodeRepo(owner, name)}/raw?${query.toString()}`;
  },
  languages: (owner: string, name: string, ref?: string) =>
    request<{ ref: string; sha?: string; items: { name: string; color: string; bytes: number; percent: number }[] }>(
      `${encodeRepo(owner, name)}/languages${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`,
    ),
  readme: (owner: string, name: string, ref?: string) =>
    request<Readme>(`${encodeRepo(owner, name)}/readme${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`),

  saveContents: (
    owner: string,
    name: string,
    input: { path: string; branch: string; content: string; encoding: "utf8" | "base64"; message?: string },
  ) => put<ContentsCommit>(`${encodeRepo(owner, name)}/contents`, input),
  deleteContents: (owner: string, name: string, input: { path: string; branch: string; message?: string }) =>
    request<ContentsCommit>(`${encodeRepo(owner, name)}/contents`, {
      method: "DELETE",
      body: JSON.stringify(input),
    }),

  releases: (owner: string, name: string) =>
    request<{ items: Release[] }>(`${encodeRepo(owner, name)}/releases`),
  createRelease: (
    owner: string,
    name: string,
    input: { tag_name: string; name?: string; body?: string; prerelease?: boolean; draft?: boolean; target?: string },
  ) => post<Release>(`${encodeRepo(owner, name)}/releases`, input),
  deleteRelease: (owner: string, name: string, id: number) =>
    del<{ ok: true }>(`${encodeRepo(owner, name)}/releases/${id}`),
  releaseAssetUrl: (owner: string, name: string, releaseId: number, assetId: number) =>
    `${encodeRepo(owner, name)}/releases/${releaseId}/assets/${assetId}`,
  uploadReleaseAsset: async (owner: string, name: string, releaseId: number, file: File): Promise<ReleaseAsset> => {
    const query = new URLSearchParams({ name: file.name });
    const response = await fetch(`${encodeRepo(owner, name)}/releases/${releaseId}/assets?${query}`, {
      method: "POST",
      headers: { "content-type": file.type || "application/octet-stream" },
      body: file,
    });
    const payload = (await response.json().catch(() => null)) as
      | { asset?: ReleaseAsset; error?: { message?: string } }
      | null;
    if (!response.ok) throw new Error(payload?.error?.message ?? "Asset upload failed");
    return payload?.asset as ReleaseAsset;
  },

  issues: (
    owner: string,
    name: string,
    state = "open",
    page = 1,
    filter: { assignee?: string; noAssignee?: boolean } = {},
  ) => {
    const params = new URLSearchParams({ state, page: String(page) });
    if (filter.assignee) params.set("assignee", filter.assignee);
    if (filter.noAssignee) params.set("no_assignee", "true");
    return request<Envelope<Issue>>(`${encodeRepo(owner, name)}/issues?${params.toString()}`);
  },
  issue: (owner: string, name: string, number: number) =>
    request<Issue>(`${encodeRepo(owner, name)}/issues/${number}`),
  createIssue: (
    owner: string,
    name: string,
    input: { title: string; body?: string; labels?: string[]; assignees?: string[] },
  ) =>
    post<Issue>(`${encodeRepo(owner, name)}/issues`, input),
  updateIssue: (owner: string, name: string, number: number, input: Record<string, unknown>) =>
    patch<Issue>(`${encodeRepo(owner, name)}/issues/${number}`, input),
  issueComments: (owner: string, name: string, number: number) =>
    request<{ items: Comment[] }>(`${encodeRepo(owner, name)}/issues/${number}/comments`),
  addIssueComment: (owner: string, name: string, number: number, body: string) =>
    post<Comment>(`${encodeRepo(owner, name)}/issues/${number}/comments`, { body }),

  pulls: (
    owner: string,
    name: string,
    state = "open",
    page = 1,
    filter: { assignee?: string; noAssignee?: boolean } = {},
  ) => {
    const params = new URLSearchParams({ state, page: String(page) });
    if (filter.assignee) params.set("assignee", filter.assignee);
    if (filter.noAssignee) params.set("no_assignee", "true");
    return request<Envelope<Pull>>(`${encodeRepo(owner, name)}/pulls?${params.toString()}`);
  },
  pull: (owner: string, name: string, number: number) =>
    request<Pull>(`${encodeRepo(owner, name)}/pulls/${number}`),
  compare: (owner: string, name: string, base: string, head: string) =>
      request<{ ahead_by: number; behind_by: number }>(`${encodeRepo(owner, name)}/compare/${encodeURIComponent(base)}.../${encodeURIComponent(head)}`),
  createPull: (owner: string, name: string, input: { title: string; body?: string; head: string; base: string }) =>
    post<Pull>(`${encodeRepo(owner, name)}/pulls`, input),
  updatePull: (owner: string, name: string, number: number, input: Record<string, unknown>) =>
    patch<Pull>(`${encodeRepo(owner, name)}/pulls/${number}`, input),
  mergePull: (owner: string, name: string, number: number) =>
    post<{ merged: boolean; sha: string; fastForward: boolean }>(
      `${encodeRepo(owner, name)}/pulls/${number}/merge`,
      {},
    ),
  pullFiles: (owner: string, name: string, number: number) =>
    request<{ comparison_available?: boolean; comparison_message?: string; comparison_kind?: string; items: import("./types.ts").FileChange[]; stats: { additions: number; deletions: number; files_changed: number } }>(
      `${encodeRepo(owner, name)}/pulls/${number}/files`,
    ),
  pullComments: (owner: string, name: string, number: number) =>
    request<{ items: Comment[] }>(`${encodeRepo(owner, name)}/pulls/${number}/comments`),
  addPullComment: (owner: string, name: string, number: number, body: string) =>
    post<Comment>(`${encodeRepo(owner, name)}/pulls/${number}/comments`, { body }),

  webhooks: (owner: string, name: string, signal?: AbortSignal) =>
    request<{ items: Webhook[]; available_events: string[] }>(`${encodeRepo(owner, name)}/webhooks`, { signal }),
  createWebhook: (
    owner: string,
    name: string,
    input: { url: string; secret?: string; events: string[] },
  ) => post<Webhook>(`${encodeRepo(owner, name)}/webhooks`, input),
  deleteWebhook: (owner: string, name: string, id: number) =>
    request<{ ok: boolean }>(`${encodeRepo(owner, name)}/webhooks/${id}`, { method: "DELETE" }),
  webhookDeliveries: (owner: string, name: string, id: number, signal?: AbortSignal) =>
    request<{ items: WebhookDelivery[] }>(`${encodeRepo(owner, name)}/webhooks/${id}/deliveries`, { signal }),

  user: (username: string) => request<User>(`/api/users/${encodeURIComponent(username)}`),
  userRepos: (username: string) =>
    request<{ items: Repo[] }>(`/api/users/${encodeURIComponent(username)}/repos`),
  userStarred: (username: string) =>
    request<{ items: Repo[] }>(`/api/users/${encodeURIComponent(username)}/starred`),
  search: (query: string, type?: string) =>
    request<SearchResults>(
      `/api/search?q=${encodeURIComponent(query)}${type ? `&type=${encodeURIComponent(type)}` : ""}`,
    ),

  orgs: () => request<{ items: Org[] }>("/api/orgs"),
  myOrgs: () => request<{ items: Org[] }>("/api/orgs/mine"),
  org: (name: string) => request<Org>(`/api/orgs/${encodeURIComponent(name)}`),
  createOrg: (input: { name: string; display_name?: string; description?: string }) =>
    post<Org>("/api/orgs", input),
  updateOrg: (name: string, input: { display_name?: string; description?: string }) =>
    patch<Org>(`/api/orgs/${encodeURIComponent(name)}`, input),
  deleteOrg: (name: string) => del<{ ok: boolean }>(`/api/orgs/${encodeURIComponent(name)}`),
  orgRepos: (name: string) =>
    request<{ items: Repo[] }>(`/api/orgs/${encodeURIComponent(name)}/repos`),
  orgMembers: (name: string) =>
    request<{ items: OrgMember[] }>(`/api/orgs/${encodeURIComponent(name)}/members`),
  addOrgMember: (name: string, username: string, role?: string) =>
    post<OrgMember>(`/api/orgs/${encodeURIComponent(name)}/members`, { username, role }),
  setOrgMemberRole: (name: string, username: string, role: string) =>
    patch<{ ok: boolean }>(
      `/api/orgs/${encodeURIComponent(name)}/members/${encodeURIComponent(username)}`,
      { role },
    ),
  removeOrgMember: (name: string, username: string) =>
    del<{ ok: boolean }>(`/api/orgs/${encodeURIComponent(name)}/members/${encodeURIComponent(username)}`),

  notifications: (options: { unread?: boolean; page?: number } = {}) => {
    const params = new URLSearchParams();
    if (options.unread) params.set("unread", "true");
    if (options.page && options.page > 1) params.set("page", String(options.page));
    const query = params.toString();
    return request<{
      items: Notification[];
      unread: number;
      total: number;
      page: number;
      per_page: number;
    }>(`/api/notifications${query ? `?${query}` : ""}`);
  },
  unreadCount: () => request<{ unread: number }>("/api/notifications/unread-count"),
  readNotification: (id: number, read = true) =>
    patch<{ ok: boolean; read: boolean }>(`/api/notifications/${id}`, { read }),
  readAllNotifications: () => post<{ ok: boolean; marked: number }>("/api/notifications/read-all", {}),
  deleteNotification: (id: number) => del<{ ok: boolean }>(`/api/notifications/${id}`),
  clearNotifications: () => del<{ ok: boolean; removed: number }>("/api/notifications"),

  sshKeys: () => request<{ items: SshKey[] }>("/api/ssh-keys"),
  addSshKey: (input: { title?: string; public_key: string }) => post<SshKey>("/api/ssh-keys", input),
  removeSshKey: (id: number) => del<{ ok: boolean }>(`/api/ssh-keys/${id}`),

  social: (owner: string, name: string) => request<SocialState>(`${encodeRepo(owner, name)}/watch`),
  star: (owner: string, name: string) =>
    put<{ starred: boolean; stars: number }>(`${encodeRepo(owner, name)}/star`, {}),
  unstar: (owner: string, name: string) =>
    del<{ starred: boolean; stars: number }>(`${encodeRepo(owner, name)}/star`),
  watch: (owner: string, name: string) =>
    put<SocialState>(`${encodeRepo(owner, name)}/watch`, {}),
  setWatchLevel: (owner: string, name: string, level: WatchLevel) =>
    put<SocialState>(`${encodeRepo(owner, name)}/watch`, { level }),
  watchers: (owner: string, name: string) =>
    request<{ watchers: number; items: RepoPerson[] }>(`${encodeRepo(owner, name)}/watchers`),
  unwatch: (owner: string, name: string) =>
    del<SocialState>(`${encodeRepo(owner, name)}/watch`),
  stargazers: (owner: string, name: string) =>
    request<{ stars: number; items: Array<{ username: string; display_name: string; avatar_hue: number; starred_at: number }> }>(
      `${encodeRepo(owner, name)}/stargazers`,
    ),
  forks: (owner: string, name: string) =>
    request<{ items: Repo[] }>(`${encodeRepo(owner, name)}/forks`),
  fork: (owner: string, name: string, input: { name?: string; description?: string; organization?: string } = {}) =>
    post<Repo>(`${encodeRepo(owner, name)}/forks`, input),
  forkParent: (owner: string, name: string) =>
    request<ForkParent>(`${encodeRepo(owner, name)}/fork-parent`),

  pushPolicy: (owner: string, name: string) =>
    request<PushPolicy>(`${encodeRepo(owner, name)}/push-policy`),
  setPushPolicy: (
    owner: string,
    name: string,
    input: { deny_non_fast_forwards?: boolean; deny_deletes?: boolean; fsck_objects?: boolean },
  ) => put<PushPolicy>(`${encodeRepo(owner, name)}/push-policy`, input),
  quota: (owner: string, name: string) =>
    request<QuotaInfo & { default_limit_bytes: number | null | undefined }>(
      `${encodeRepo(owner, name)}/quota`,
    ),
  setQuota: (owner: string, name: string, quotaBytes: number | null) =>
    put<Repo>(`${encodeRepo(owner, name)}/quota`, { quota_bytes: quotaBytes }),

  assignableUsers: (owner: string, name: string) =>
    request<{ items: Assignee[] }>(`${encodeRepo(owner, name)}/assignees`),
  assign: (
    owner: string,
    name: string,
    kind: "issue" | "pull",
    number: number,
    body: { add?: string[]; remove?: string[] },
  ) =>
    post<{ items: Assignee[]; added: number; removed: number }>(
      `${encodeRepo(owner, name)}/${kind === "issue" ? "issues" : "pulls"}/${number}/assignees`,
      body,
    ),

  milestones: (owner: string, name: string, state: "open" | "closed" | "all" = "open") =>
    request<{ items: Milestone[] }>(`${encodeRepo(owner, name)}/milestones?state=${state}`),
  createMilestone: (
    owner: string,
    name: string,
    input: { title: string; description?: string; due_on?: string },
  ) => post<Milestone>(`${encodeRepo(owner, name)}/milestones`, input),
  milestone: (owner: string, name: string, number: number) =>
    request<Milestone>(`${encodeRepo(owner, name)}/milestones/${number}`),
  milestoneItems: (owner: string, name: string, number: number) =>
    request<MilestoneItems>(`${encodeRepo(owner, name)}/milestones/${number}/items`),
  setIssueMilestone: (owner: string, name: string, number: number, milestoneId: number | null) =>
    post<{ ok: boolean; milestone_id: number | null }>(`${encodeRepo(owner, name)}/issues/${number}/milestone`, {
      milestone_id: milestoneId,
    }),
  setPullMilestone: (owner: string, name: string, number: number, milestoneId: number | null) =>
    post<{ ok: boolean; milestone_id: number | null }>(`${encodeRepo(owner, name)}/pulls/${number}/milestone`, {
      milestone_id: milestoneId,
    }),

  topics: (owner: string, name: string) =>
    request<TopicsResponse>(`${encodeRepo(owner, name)}/topics`),
  setTopics: (owner: string, name: string, names: string[]) =>
    put<TopicsResponse>(`${encodeRepo(owner, name)}/topics`, { names }),
  reposByTopic: (topic: string, page = 1) =>
    request<{ items: Array<{ full_name: string; name: string; owner: string; description: string }>; total: number }>(
      `/api/topics/${encodeURIComponent(topic)}/repos?page=${page}`,
    ),
  popularTopics: (limit = 30) =>
    request<{ items: Array<{ name: string; repo_count: number }> }>(`/api/topics?limit=${limit}`),

  threadEvents: (owner: string, name: string, kind: "issue" | "pull", number: number) =>
    request<Envelope<ThreadEvent>>(
      `${encodeRepo(owner, name)}/${kind === "issue" ? "issues" : "pulls"}/${number}/events`,
    ),
  collaborators: (owner: string, name: string) =>
    request<CollaboratorsResponse>(`${encodeRepo(owner, name)}/collaborators`),
  addCollaborator: (owner: string, name: string, username: string, permission: "read" | "write") =>
    post<{ username: string; permission: string }>(`${encodeRepo(owner, name)}/collaborators`, {
      username,
      permission,
    }),
  removeCollaborator: (owner: string, name: string, username: string) =>
    del<{ ok: true }>(`${encodeRepo(owner, name)}/collaborators/${encodeURIComponent(username)}`),

  ciRuns: (owner: string, name: string, signal?: AbortSignal, before?: number) =>
    request<{ items: CiRun[]; next_before: number | null; runner: CiRunnerInfo; can_write: boolean }>(`${encodeRepo(owner, name)}/ci/runs${before === undefined ? "" : `?before=${before}`}`, { signal }),
  ciLog: (owner: string, name: string, id: number, after = 0, signal?: AbortSignal) =>
    request<{ items: CiLogLine[]; next: number }>(
      `${encodeRepo(owner, name)}/ci/runs/${id}/log?after=${after}&limit=500`, { signal },
    ),
  accountSettings: () => request<AccountSettings>("/api/account"),
  updateAccount: (input: { username?: string; email?: string; display_name?: string }) =>
    patch<{ user: User; bootstrap_pending: boolean }>("/api/account", input),
  changePassword: (currentPassword: string, newPassword: string) =>
    post<{ ok: true }>("/api/account/password", {
      current_password: currentPassword,
      new_password: newPassword,
    }),

  loginMfa: (username: string, password: string, code: string) =>
    post<LoginResult>("/api/auth/login/mfa", { username, password, code }),

  mfaState: () => request<MfaState>("/api/auth/mfa"),
  beginTotp: () => post<{ secret: string; uri: string; confirmed: boolean }>("/api/auth/mfa/totp/begin", {}),
  confirmTotp: (code: string) =>
    post<{ confirmed: boolean; recovery_codes: string[] }>("/api/auth/mfa/totp/confirm", { code }),
  disableTotp: (code: string) => post<{ confirmed: boolean }>("/api/auth/mfa/totp/disable", { code }),
  regenerateRecoveryCodes: (code: string) =>
    post<{ recovery_codes: string[] }>("/api/auth/mfa/recovery-codes", { code }),

  passkeyRegisterChallenge: (label: string) =>
    post<PasskeyChallenge>("/api/auth/passkeys/challenge", { label }),
  passkeyRegister: (payload: {
    credential_id: string;
    public_key: string;
    client_data_json: string;
    sign_count?: number;
    label?: string;
  }) => post<{ ok: true; count: number }>("/api/auth/passkeys", payload),
  passkeyLoginChallenge: (username: string) =>
    post<{ challenge: string; rpId: string; allowCredentials: Array<{ type: string; id: string }> }>(
      "/api/auth/passkeys/challenge-login",
      { username },
    ),
  passkeyAssert: (payload: {
    username: string;
    credential_id: string;
    client_data_json: string;
    authenticator_data: string;
    signature: string;
  }) => post<{ user: User }>("/api/auth/passkeys/assert", payload),
  deletePasskey: (id: number) => del<{ ok: true; count: number }>(`/api/auth/passkeys/${id}`),

  searchCode: (query: string, repo?: string) => {
    const params = new URLSearchParams({ q: query });
    if (repo) params.set("repo", repo);
    return request<{
      items: Array<{ repository: string; path: string; language: string; snippet: string }>;
      truncated_index: boolean;
      at_result_limit: boolean;
    }>(`/api/search/code?${params.toString()}`);
  },
};
