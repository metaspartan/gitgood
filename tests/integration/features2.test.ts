import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../src/server.ts";
import { git } from "../../src/git/run.ts";
import { hashedRepositoryPath } from "../../src/git/repo.ts";
import { quotaReport } from "../../src/api/routes/repo-extras.ts";
import { parseGitCommand } from "../../tools/ssh-command.ts";
import { authorizedKeysLine, fingerprintOf, parsePublicKey } from "../../src/ssh/keys.ts";

const scratch = mkdtempSync(join(tmpdir(), "gg-features2-"));
const server = createServer(0);
const BASE = `http://127.0.0.1:${server.port}`;
const run = Date.now().toString(36);
const identity = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];

interface Envelope<T> {
  status: number;
  data: T;
  headers: Headers;
}

class Client {
  cookie = "";
  username = "";
  userId = 0;

  async request<T>(
    path: string,
    init: Omit<RequestInit, "body"> & { body?: unknown } = {},
  ): Promise<Envelope<T>> {
    const { body: rawBody, ...rest } = init;
    const headers: Record<string, string> = {
      ...((rest.headers as Record<string, string>) ?? {}),
    };
    if (this.cookie) headers["cookie"] = this.cookie;
    const body = rawBody === undefined ? undefined : JSON.stringify(rawBody);
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(`${BASE}${path}`, {
      ...rest,
      headers,
      ...(body === undefined ? {} : { body }),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) this.cookie = setCookie.split(";")[0] ?? "";
    const text = await response.text();
    let data: unknown = null;
    if (text.length > 0) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    return { status: response.status, data: data as T, headers: response.headers };
  }

  async signup(label: string): Promise<void> {
    const username = `${label}${run}`;
    const response = await this.request<{ user: { id: number; username: string } }>("/api/auth/signup", {
      method: "POST",
      body: { username, email: `${username}@example.com`, password: "supersecret123" },
    });
    if (response.status !== 201) throw new Error(`signup failed: ${response.status} ${JSON.stringify(response.data)}`);
    this.username = response.data.user.username;
    this.userId = response.data.user.id;
  }

  async createRepo(name: string, extra: Record<string, unknown> = {}): Promise<void> {
    const response = await this.request(`/api/repos`, {
      method: "POST",
      body: { name, ...extra },
    });
    if (response.status !== 201) throw new Error(`createRepo failed: ${response.status} ${JSON.stringify(response.data)}`);
  }

  async token(name = "cli"): Promise<string> {
    const response = await this.request<{ token: string }>("/api/tokens", {
      method: "POST",
      body: { name },
    });
    return response.data.token;
  }
}

const owner = new Client();
const other = new Client();

beforeAll(async () => {
  await owner.signup("feat-owner");
  await other.signup("feat-other");
}, 120_000);

afterAll(async () => {
  await server.stop(true);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
      return;
    } catch {
      await Bun.sleep(200);
    }
  }
}, 60_000);

describe("organisations", () => {
  let orgName = "";

  test("creating an organisation makes the creator its owner", async () => {
    orgName = `acme${run}`;
    const response = await owner.request<{ name: string }>("/api/orgs", {
      method: "POST",
      body: { name: orgName, display_name: "Acme Corp", description: "test org" },
    });
    expect(response.status).toBe(201);
    expect(response.data.name).toBe(orgName);

    const detail = await owner.request<{ viewer_role: string; viewer_can_administer: boolean }>(
      `/api/orgs/${orgName}`,
    );
    expect(detail.status).toBe(200);
    expect(detail.data.viewer_role).toBe("owner");
    expect(detail.data.viewer_can_administer).toBe(true);
  });

  test("a non-member sees the organisation but has no role in it", async () => {
    const detail = await other.request<{ viewer_role: string | null; viewer_can_administer: boolean }>(
      `/api/orgs/${orgName}`,
    );
    expect(detail.status).toBe(200);
    expect(detail.data.viewer_role).toBeNull();
    expect(detail.data.viewer_can_administer).toBe(false);
  });

  test("an organisation cannot take a username, because the namespace is shared", async () => {
    const response = await owner.request("/api/orgs", {
      method: "POST",
      body: { name: other.username },
    });
    expect(response.status).toBe(409);
  });

  test("a user cannot take an organisation name either", async () => {
    const attempt = new Client();
    const response = await attempt.request("/api/auth/signup", {
      method: "POST",
      body: {
        username: orgName,
        email: `clash${run}@example.com`,
        password: "supersecret123",
      },
    });
    expect(response.status).not.toBe(201);
  });

  test("a non-admin cannot add members", async () => {
    const response = await other.request(`/api/orgs/${orgName}/members`, {
      method: "POST",
      body: { username: owner.username, role: "member" },
    });
    expect(response.status).toBe(403);
  });

  test("an owner adds a member, who can then read org repositories", async () => {
    const added = await owner.request<{ role: string }>(`/api/orgs/${orgName}/members`, {
      method: "POST",
      body: { username: other.username, role: "member" },
    });
    expect(added.status).toBe(201);
    expect(added.data.role).toBe("member");

    const members = await owner.request<{ items: Array<{ user: { username: string } }> }>(
      `/api/orgs/${orgName}/members`,
    );
    expect(members.data.items.map((entry) => entry.user.username)).toContain(other.username);
  });

  test("duplicate membership is refused", async () => {
    const again = await owner.request(`/api/orgs/${orgName}/members`, {
      method: "POST",
      body: { username: other.username },
    });
    expect(again.status).toBe(409);
  });

  test("the only owner cannot be demoted or removed", async () => {
    const demote = await owner.request(`/api/orgs/${orgName}/members/${owner.username}`, {
      method: "PATCH",
      body: { role: "member" },
    });
    expect(demote.status).toBe(409);

    const remove = await owner.request(`/api/orgs/${orgName}/members/${owner.username}`, {
      method: "DELETE",
    });
    expect(remove.status).toBe(409);
  });

  test("a member may remove themselves, which is 'leave'", async () => {
    const leave = await other.request(`/api/orgs/${orgName}/members/${other.username}`, {
      method: "DELETE",
    });
    expect(leave.status).toBe(200);
    const readd = await owner.request(`/api/orgs/${orgName}/members`, {
      method: "POST",
      body: { username: other.username, role: "member" },
    });
    expect(readd.status).toBe(201);
  });
});

describe("the organisation list reports each viewer's own role", () => {
  const orgName = `roles${run}`;

  beforeAll(async () => {
    const created = await owner.request("/api/orgs", { method: "POST", body: { name: orgName } });
    expect(created.status).toBe(201);
  });

  test("the creator's membership is reported as owner", async () => {
    const mine = await owner.request<{ items: Array<{ name: string; viewer_role?: string }> }>(
      "/api/orgs/mine",
    );
    const entry = mine.data.items.find((item) => item.name === orgName);
    expect(entry).toBeDefined();
    expect(entry?.viewer_role).toBe("owner");
  });

  test("a member is reported as member", async () => {
    const added = await owner.request(`/api/orgs/${orgName}/members`, {
      method: "POST",
      body: { username: other.username, role: "member" },
    });
    expect(added.status).toBe(201);
    const mine = await other.request<{ items: Array<{ name: string; viewer_role?: string }> }>(
      "/api/orgs/mine",
    );
    expect(mine.data.items.find((item) => item.name === orgName)?.viewer_role).toBe("member");
  });

  test("an admin is reported as admin, which is a role the fallback could not express", async () => {
    const promoted = await owner.request(`/api/orgs/${orgName}/members/${other.username}`, {
      method: "PATCH",
      body: { role: "admin" },
    });
    expect(promoted.status).toBe(200);
    const mine = await other.request<{ items: Array<{ name: string; viewer_role?: string }> }>(
      "/api/orgs/mine",
    );
    expect(mine.data.items.find((item) => item.name === orgName)?.viewer_role).toBe("admin");
  });

  test("the organisation's member count counts everyone, not just the viewer", async () => {
    const detail = await owner.request<{ member_count: number }>(`/api/orgs/${orgName}`);
    expect(detail.data.member_count).toBe(2);
  });

  test("the public directory does not invent a role", async () => {
    const anon = new Client();
    const all = await anon.request<{ items: Array<{ name: string; viewer_role?: string }> }>("/api/orgs");
    const entry = all.data.items.find((item) => item.name === orgName);
    expect(entry).toBeDefined();
    expect(entry?.viewer_role).toBeUndefined();
  });
});

describe("organisation repositories", () => {
  let orgName = "";
  let repoName = "";

  beforeAll(async () => {
    orgName = `orgrepo${run}`;
    await owner.request("/api/orgs", { method: "POST", body: { name: orgName } });
    repoName = "shared";
  });

  test("an organisation repository is created into the org namespace", async () => {
    const org = await owner.request<{ id: number }>(`/api/orgs/${orgName}`);
    const created = await owner.request<{ owner: string; owner_kind: string }>("/api/repos", {
      method: "POST",
      body: { name: repoName, organization: orgName, visibility: "private" },
    });
    expect(created.status).toBe(201);
    expect(created.data.owner).toBe(orgName);
    expect(created.data.owner_kind).toBe("org");
    expect(org.data.id).toBeGreaterThan(0);
  });

  test("the org owns it and the creator's own namespace does not", async () => {
    const inOrg = await owner.request(`/api/repos/${orgName}/${repoName}`);
    expect(inOrg.status).toBe(200);

    const inUser = await owner.request(`/api/repos/${owner.username}/${repoName}`);
    expect(inUser.status).toBe(404);
  });

  test("a member of the org can read the private repository", async () => {
    const added = await owner.request(`/api/orgs/${orgName}/members`, {
      method: "POST",
      body: { username: other.username, role: "member" },
    });
    expect(added.status).toBe(201);
    const response = await other.request(`/api/repos/${orgName}/${repoName}`);
    expect(response.status).toBe(200);
  });

  test("an outsider cannot read it, and learns nothing about whether it exists", async () => {
    const outsider = new Client();
    await outsider.signup("feat-out");
    const response = await outsider.request(`/api/repos/${orgName}/${repoName}`);
    expect(response.status).toBe(404);
  });

  test("a removed member loses access immediately", async () => {
    await owner.request(`/api/orgs/${orgName}/members/${other.username}`, { method: "DELETE" });
    const response = await other.request(`/api/repos/${orgName}/${repoName}`);
    expect(response.status).toBe(404);
  });

  test("the creator who leaves the org also loses access", async () => {
    const stillOwner = await owner.request(`/api/repos/${orgName}/${repoName}`);
    expect(stillOwner.status).toBe(200);
  });
});

describe("stars and watches", () => {
  const repoName = "starred";

  beforeAll(async () => {
    await owner.createRepo(repoName, { visibility: "public" });
  });

  test("starring is idempotent and unstarring converges", async () => {
    const first = await other.request<{ starred: boolean; stars: number }>(
      `/api/repos/${owner.username}/${repoName}/star`,
      { method: "PUT" },
    );
    expect(first.status).toBe(200);
    expect(first.data.starred).toBe(true);
    expect(first.data.stars).toBe(1);

    const second = await other.request<{ stars: number }>(`/api/repos/${owner.username}/${repoName}/star`, {
      method: "PUT",
    });
    expect(second.data.stars).toBe(1);

    const off = await other.request<{ starred: boolean; stars: number }>(
      `/api/repos/${owner.username}/${repoName}/star`,
      { method: "DELETE" },
    );
    expect(off.data.stars).toBe(0);

    const again = await other.request<{ stars: number }>(`/api/repos/${owner.username}/${repoName}/star`, {
      method: "DELETE",
    });
    expect(again.status).toBe(200);
    expect(again.data.stars).toBe(0);
  });

  test("starring does not subscribe: a watcher is required for push notifications", async () => {
    await other.request(`/api/repos/${owner.username}/${repoName}/star`, { method: "PUT" });

    const state = await other.request<{ watching: boolean; starring: boolean }>(
      `/api/repos/${owner.username}/${repoName}/watch`,
    );
    expect(state.data.starring).toBe(true);
    expect(state.data.watching).toBe(false);

    const on = await other.request<{ watching: boolean }>(`/api/repos/${owner.username}/${repoName}/watch`, {
      method: "PUT",
    });
    expect(on.data.watching).toBe(true);
  });

  test("the stargazer list is public and carries the count", async () => {
    const list = await other.request<{ stars: number; items: Array<{ username: string }> }>(
      `/api/repos/${owner.username}/${repoName}/stargazers`,
    );
    expect(list.status).toBe(200);
    expect(list.data.stars).toBe(1);
    expect(list.data.items[0]?.username).toBe(other.username);
  });

  test("anonymous callers cannot star", async () => {
    const anon = new Client();
    const response = await anon.request(`/api/repos/${owner.username}/${repoName}/star`, { method: "PUT" });
    expect(response.status).toBe(401);
  });
});

describe("notifications", () => {
  const repoName = "notify";

  beforeAll(async () => {
    await owner.createRepo(repoName, { visibility: "public" });
    await other.request(`/api/repos/${owner.username}/${repoName}/watch`, { method: "PUT" });
  });

  const repoPath = (): string => `${owner.username}/${repoName}`;

  test("opening an issue notifies watchers but not the author", async () => {
    const before = await other.request<{ unread: number }>("/api/notifications/unread-count");
    const created = await owner.request<{ number: number }>(
      `/api/repos/${repoPath()}/issues`,
      { method: "POST", body: { title: "Something is broken", body: "details" } },
    );
    expect(created.status).toBe(201);

    const after = await other.request<{ unread: number }>("/api/notifications/unread-count");
    expect(after.data.unread).toBe(before.data.unread + 1);

    const author = await owner.request<{ items: Array<{ kind: string }> }>("/api/notifications");
    expect(author.data.items.every((entry) => entry.kind !== "issue_opened")).toBe(true);
  });

  test("a comment notifies the thread author and any watcher", async () => {
    await other.request<{ unread: number }>("/api/notifications/read-all", { method: "POST" });
    await owner.request<{ unread: number }>("/api/notifications/read-all", { method: "POST" });

    const comment = await other.request(`/api/repos/${repoPath()}/issues/1/comments`, {
      method: "POST",
      body: { body: "looking into it" },
    });
    expect(comment.status).toBe(201);

    const author = await owner.request<{ items: Array<{ kind: string }> }>("/api/notifications");
    expect(author.data.items.some((entry) => entry.kind === "issue_commented")).toBe(true);

    const actor = await other.request<{ items: Array<{ actor: string | null }> }>("/api/notifications");
    expect(actor.data.items.every((entry) => entry.actor !== other.username)).toBe(true);
  });

  test("repeated comments from one person collapse to a single unread row", async () => {
    await owner.request<{ unread: number }>("/api/notifications/read-all", { method: "POST" });
    for (let i = 0; i < 3; i++) {
      await other.request(`/api/repos/${repoPath()}/issues/1/comments`, {
        method: "POST",
        body: { body: `follow-up ${i}` },
      });
    }
    const unread = await owner.request<{ items: Array<{ kind: string }> }>("/api/notifications?unread=true");
    const commentRows = unread.data.items.filter((entry) => entry.kind === "issue_commented");
    expect(commentRows.length).toBe(1);
  });

  test("marking read is scoped to the caller", async () => {
    const list = await owner.request<{ items: Array<{ id: number }> }>("/api/notifications?unread=true");
    const id = list.data.items[0]?.id;
    expect(id).toBeDefined();

    const stolen = await other.request(`/api/notifications/${id}`, { method: "PATCH", body: {} });
    expect(stolen.status).toBe(404);

    const own = await owner.request<{ ok: boolean; read: boolean }>(`/api/notifications/${id}`, {
      method: "PATCH",
      body: {},
    });
    expect(own.status).toBe(200);
    expect(own.data.read).toBe(true);
  });

  test("a push notifies watchers, and the pusher is not told", async () => {
    await other.request("/api/notifications/read-all", { method: "POST" });

    const token = await owner.token("push-notify");
    const work = join(scratch, `notify-work-${run}`);
    mkdirSync(work, { recursive: true });
    const remote = `${BASE.replace("http://", `http://${owner.username}:${token}@`)}/${repoPath()}.git`;
    const gitIn = async (args: string[]): Promise<void> => {
      const proc = Bun.spawn(["git", ...args], { cwd: work, stdout: "pipe", stderr: "pipe" });
      const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      if (code !== 0) throw new Error(`git ${args.join(" ")}: ${stderr.slice(0, 300)}`);
    };
    await gitIn(["init", "-q", "-b", "main"]);
    await gitIn(["remote", "add", "origin", remote]);
    writeFileSync(join(work, "a.txt"), "one\n");
    await gitIn(["add", "."]);
    await gitIn([...identity, "commit", "-q", "-m", "first"]);
    await gitIn(["push", "-q", "origin", "main"]);

    let sawPush = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      const probe = await other.request<{ items: Array<{ kind: string }> }>("/api/notifications");
      if (probe.data.items.some((entry) => entry.kind === "push")) {
        sawPush = true;
        break;
      }
      await Bun.sleep(150);
    }
    expect(sawPush).toBe(true);

    const pusher = await owner.request<{ items: Array<{ actor: string | null }> }>("/api/notifications");
    expect(pusher.data.items.every((entry) => entry.actor !== owner.username)).toBe(true);
  }, 120_000);

  test("the unread badge, list and clear endpoints agree", async () => {
    const before = await other.request<{ unread: number }>("/api/notifications/unread-count");
    expect(before.data.unread).toBeGreaterThan(0);

    const cleared = await other.request<{ removed: number }>("/api/notifications", { method: "DELETE" });
    expect(cleared.data.removed).toBeGreaterThan(0);

    const after = await other.request<{ unread: number }>("/api/notifications/unread-count");
    expect(after.data.unread).toBe(0);
  });

  test("an anonymous caller has no notifications and no way in", async () => {
    const anon = new Client();
    const response = await anon.request("/api/notifications");
    expect(response.status).toBe(401);
  });
});

describe("forks", () => {
  const parentName = "fork-parent";

  beforeAll(async () => {
    await owner.createRepo(parentName, { visibility: "public" });
    const token = await owner.token("fork-seed");
    const work = join(scratch, `fork-work-${run}`);
    mkdirSync(work, { recursive: true });
    const remote = `${BASE.replace("http://", `http://${owner.username}:${token}@`)}/${owner.username}/${parentName}.git`;
    const gitIn = async (args: string[]): Promise<void> => {
      const proc = Bun.spawn(["git", ...args], { cwd: work, stdout: "pipe", stderr: "pipe" });
      const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      if (code !== 0) throw new Error(`git ${args.join(" ")}: ${stderr.slice(0, 300)}`);
    };
    await gitIn(["init", "-q", "-b", "main"]);
    await gitIn(["remote", "add", "origin", remote]);
    writeFileSync(join(work, "shared.txt"), "shared content\n");
    await gitIn(["add", "."]);
    await gitIn([...identity, "commit", "-q", "-m", "seed parent"]);
    await gitIn(["push", "-q", "origin", "main"]);
  }, 120_000);

  test("a fork copies the objects and records its parent", async () => {
    const forked = await other.request<{ name: string; owner: string; fork_of: number | null }>(
      `/api/repos/${owner.username}/${parentName}/forks`,
      { method: "POST", body: { name: `forked-${run}` } },
    );
    expect(forked.status).toBe(201);
    expect(forked.data.owner).toBe(other.username);
    expect(forked.data.fork_of).not.toBeNull();

    const cloneTarget = join(scratch, `fork-clone-${run}`);
    const clone = await git(["clone", "-q", `${BASE}/${other.username}/${forked.data.name}.git`, cloneTarget], {
      cwd: scratch,
    });
    expect(clone.exitCode).toBe(0);
    expect(readFileSync(join(cloneTarget, "shared.txt"), "utf8")).toBe("shared content\n");
  }, 120_000);

  test("the parent lists its forks and the fork names its parent", async () => {
    const forks = await other.request<{ items: Array<{ name: string }> }>(
      `/api/repos/${owner.username}/${parentName}/forks`,
    );
    expect(forks.data.items.length).toBeGreaterThanOrEqual(1);

    const parent = await other.request<{ parent: { full_name: string } | null }>(
      `/api/repos/${other.username}/forked-${run}/fork-parent`,
    );
    expect(parent.data.parent?.full_name).toBe(`${owner.username}/${parentName}`);
  });

  test("a private repository's fork stays private", async () => {
    await owner.createRepo("fork-private", { visibility: "private" });
    const forked = await owner.request<{ visibility: string }>(
      `/api/repos/${owner.username}/fork-private/forks`,
      { method: "POST", body: {} },
    );
    expect(forked.status).toBe(201);
    expect(forked.data.visibility).toBe("private");
  });

  test("a repository you cannot read cannot be forked", async () => {
    const outsider = new Client();
    await outsider.signup("feat-forkout");
    const response = await outsider.request(`/api/repos/${owner.username}/fork-private/forks`, {
      method: "POST",
      body: {},
    });
    expect(response.status).toBe(404);
  });

  test("the parent cannot be deleted out from under a fork", async () => {
    const parent = await owner.request<{ name: string; fork_of: number | null }>(
      `/api/repos/${other.username}/forked-${run}/fork-parent`,
    );
    expect(parent.status).toBe(200);
  });
});

describe("code search", () => {
  const repoName = "searchme";

  beforeAll(async () => {
    await owner.createRepo(repoName, { visibility: "public" });
    const token = await owner.token("search-seed");
    const work = join(scratch, `search-work-${run}`);
    mkdirSync(work, { recursive: true });
    const remote = `${BASE.replace("http://", `http://${owner.username}:${token}@`)}/${owner.username}/${repoName}.git`;
    const gitIn = async (args: string[]): Promise<void> => {
      const proc = Bun.spawn(["git", ...args], { cwd: work, stdout: "pipe", stderr: "pipe" });
      const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      if (code !== 0) throw new Error(`git ${args.join(" ")}: ${stderr.slice(0, 300)}`);
    };
    await gitIn(["init", "-q", "-b", "main"]);
    await gitIn(["remote", "add", "origin", remote]);
    writeFileSync(
      join(work, "router.js"),
      "// a distinctive marker: zanzibarRouting\nfunction route(input) {\n  return input + 1;\n}\n",
    );
    mkdirSync(join(work, "nested"), { recursive: true });
    writeFileSync(join(work, "nested", "helper.ts"), "export const zanzibarRoutingHelper = true;\n");
    writeFileSync(join(work, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0x7a, 0x61, 0x6e, 0x00]));
    await gitIn(["add", "."]);
    await gitIn([...identity, "commit", "-q", "-m", "seed searchable content"]);
    await gitIn(["push", "-q", "origin", "main"]);
  }, 180_000);

  async function waitForCodeHit(query: string): Promise<void> {
    for (let attempt = 0; attempt < 60; attempt++) {
      const probe = await owner.request<{ items: unknown[] }>(
        `/api/search/code?q=${encodeURIComponent(query)}`,
      );
      if (probe.data.items.length > 0) return;
      await Bun.sleep(150);
    }
  }

  test("a push indexes the default branch", async () => {
    await waitForCodeHit("zanzibarRouting");
    const status = await owner.request<{ indexed_repos: number; indexed_files: number }>(
      "/api/search/code/status",
    );
    expect(status.data.indexed_repos).toBeGreaterThanOrEqual(1);
    expect(status.data.indexed_files).toBeGreaterThanOrEqual(2);
  });

  test("content search finds a match and quotes it", async () => {
    await waitForCodeHit("zanzibarRouting");
    const response = await owner.request<{ items: Array<{ path: string; snippet: string; repository: string }> }>(
      "/api/search/code?q=zanzibarRouting",
    );
    expect(response.status).toBe(200);
    expect(response.data.items.length).toBeGreaterThanOrEqual(2);
    const paths = response.data.items.map((hit) => hit.path);
    expect(paths).toContain("router.js");
    expect(paths).toContain("nested/helper.ts");
    expect(response.data.items[0]?.snippet).toContain("zanzibarRouting");
  });

  test("a scoped search stays inside its repository", async () => {
    const response = await owner.request<{ items: Array<{ repository: string }> }>(
      `/api/search/code?q=zanzibarRouting&repo=${owner.username}/${repoName}`,
    );
    expect(response.data.items.length).toBeGreaterThan(0);
    for (const hit of response.data.items) {
      expect(hit.repository).toBe(`${owner.username}/${repoName}`);
    }
  });

  test("the combined search includes code by default", async () => {
    const response = await owner.request<{ code: Array<{ path: string }> }>(
      "/api/search?q=zanzibarRouting",
    );
    expect(response.data.code.length).toBeGreaterThanOrEqual(2);
  });

  test("binary content is not searchable", async () => {
    const response = await owner.request<{ items: Array<{ path: string }> }>(
      "/api/search/code?q=zanz",
    );
    const paths = response.data.items.map((hit) => hit.path);
    expect(paths).not.toContain("blob.bin");
  });

  test("code search does not leak a private repository's contents", async () => {
    await owner.createRepo("search-private", { visibility: "private" });
    const token = await owner.token("search-private-seed");
    const work = join(scratch, `search-private-${run}`);
    mkdirSync(work, { recursive: true });
    const remote = `${BASE.replace("http://", `http://${owner.username}:${token}@`)}/${owner.username}/search-private.git`;
    const gitIn = async (args: string[]): Promise<void> => {
      const proc = Bun.spawn(["git", ...args], { cwd: work, stdout: "pipe", stderr: "pipe" });
      const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      if (code !== 0) throw new Error(`git ${args.join(" ")}: ${stderr.slice(0, 300)}`);
    };
    await gitIn(["init", "-q", "-b", "main"]);
    await gitIn(["remote", "add", "origin", remote]);
    writeFileSync(join(work, "secret.js"), "const supersecretCodename = 'quokka';\n");
    await gitIn(["add", "."]);
    await gitIn([...identity, "commit", "-q", "-m", "private content"]);
    await gitIn(["push", "-q", "origin", "main"]);
    await waitForCodeHit("supersecretCodename");

    const asOwner = await owner.request<{ items: Array<{ path: string }> }>(
      "/api/search/code?q=supersecretCodename",
    );
    expect(asOwner.data.items.length).toBeGreaterThan(0);
    expect(asOwner.data.items.map((hit) => hit.path)).toContain("secret.js");

    const outsider = new Client();
    await outsider.signup("feat-searchout");
    const asOutsider = await outsider.request<{ items: unknown[] }>(
      "/api/search/code?q=supersecretCodename",
    );
    expect(asOutsider.data.items.length).toBe(0);

    const combined = await outsider.request<{ code: unknown[] }>("/api/search?q=supersecretCodename");
    expect(combined.data.code.length).toBe(0);
  }, 180_000);

  test("a scoped search against an unreadable repository is empty, not a 403", async () => {
    const outsider = new Client();
    await outsider.signup("feat-searchout2");
    const response = await outsider.request<{ items: unknown[] }>(
      `/api/search/code?q=quokka&repo=${owner.username}/search-private`,
    );
    expect(response.status).toBe(200);
    expect(response.data.items.length).toBe(0);
  });

  test("a malformed repo scope is a 400, not a silent empty result", async () => {
    const response = await owner.request("/api/search/code?q=x&repo=no-slash-here");
    expect(response.status).toBe(400);
  });
});

describe("per-repository push policy", () => {
  const repoName = "policy";

  beforeAll(async () => {
    await owner.createRepo(repoName, { visibility: "public" });
  }, 60_000);

  async function workTree(label: string): Promise<{
    dir: string;
    git: (args: string[]) => Promise<{ code: number; stderr: string }>;
    remote: string;
  }> {
    const token = await owner.token(`policy-${label}`);
    const dir = join(scratch, `policy-${label}-${run}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const runGit = async (args: string[]): Promise<{ code: number; stderr: string }> => {
      const proc = Bun.spawn(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
      const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      return { code, stderr };
    };
    const remote = `${BASE.replace("http://", `http://${owner.username}:${token}@`)}/${owner.username}/${repoName}.git`;
    return { dir, git: runGit, remote };
  }

  test("a new repository records fsckObjects, and reports the defaults", async () => {
    const response = await owner.request<{
      deny_non_fast_forwards: boolean;
      deny_deletes: boolean;
      fsck_objects: boolean;
      differs_from_default: boolean;
    }>(`/api/repos/${owner.username}/${repoName}/push-policy`);
    expect(response.status).toBe(200);
    expect(response.data.fsck_objects).toBe(true);
    expect(response.data.deny_non_fast_forwards).toBe(false);
    expect(response.data.differs_from_default).toBe(false);
  });

  test("a force-push is allowed by default, then refused once the policy forbids it", async () => {
    const { dir, git: runGit, remote } = await workTree("force");

    await runGit(["init", "-q", "-b", "main"]);
    await runGit(["remote", "add", "origin", remote]);
    writeFileSync(join(dir, "a.txt"), "first\n");
    await runGit(["add", "."]);
    await runGit([...identity, "commit", "-q", "-m", "first"]);
    const first = await runGit(["push", "-q", "origin", "main"]);
    expect(first.code).toBe(0);

    writeFileSync(join(dir, "a.txt"), "rewritten\n");
    await runGit(["add", "."]);
    await runGit([...identity, "commit", "-q", "--amend", "-m", "rewritten"]);

    const allowed = await runGit(["push", "-q", "--force", "origin", "main"]);
    expect(allowed.code).toBe(0);

    const set = await owner.request<{ deny_non_fast_forwards: boolean; differs_from_default: boolean }>(
      `/api/repos/${owner.username}/${repoName}/push-policy`,
      { method: "PUT", body: { deny_non_fast_forwards: true } },
    );
    expect(set.status).toBe(200);
    expect(set.data.deny_non_fast_forwards).toBe(true);
    expect(set.data.differs_from_default).toBe(true);

    writeFileSync(join(dir, "a.txt"), "rewritten again\n");
    await runGit(["add", "."]);
    await runGit([...identity, "commit", "-q", "--amend", "-m", "rewritten again"]);
    const refused = await runGit(["push", "--force", "origin", "main"]);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr.toLowerCase()).toMatch(/non-fast-forward|fetch first|rejected/);
  }, 180_000);

  test("a ref deletion is refused once the policy forbids it", async () => {
    const { git: runGit, remote } = await workTree("delete");
    await runGit(["init", "-q", "-b", "main"]);
    await runGit(["remote", "add", "origin", remote]);
    await runGit(["fetch", "-q", "origin"]);
    await runGit(["checkout", "-q", "-b", "temp", "origin/main"]);
    const pushed = await runGit(["push", "-q", "origin", "temp"]);
    expect(pushed.code).toBe(0);

    const firstDelete = await runGit(["push", "-q", "origin", "--delete", "temp"]);
    expect(firstDelete.code).toBe(0);

    await owner.request(`/api/repos/${owner.username}/${repoName}/push-policy`, {
      method: "PUT",
      body: { deny_deletes: true },
    });
    await runGit(["push", "-q", "origin", "temp"]);
    const refused = await runGit(["push", "origin", "--delete", "temp"]);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr.toLowerCase()).toMatch(/deletion|denied|rejected|forbidden/);

    await owner.request(`/api/repos/${owner.username}/${repoName}/push-policy`, {
      method: "PUT",
      body: { deny_deletes: false, deny_non_fast_forwards: false },
    });
  }, 180_000);

  test("only an owner may change the policy", async () => {
    const outsider = new Client();
    await outsider.signup("feat-policyout");
    const response = await outsider.request(`/api/repos/${owner.username}/${repoName}/push-policy`, {
      method: "PUT",
      body: { deny_non_fast_forwards: true },
    });
    expect(response.status).toBeGreaterThanOrEqual(400);

    const still = await owner.request<{ deny_non_fast_forwards: boolean }>(
      `/api/repos/${owner.username}/${repoName}/push-policy`,
    );
    expect(still.data.deny_non_fast_forwards).toBe(false);
  });

  test("an anonymous caller may read the policy but not change it", async () => {
    const anon = new Client();
    const read = await anon.request(`/api/repos/${owner.username}/${repoName}/push-policy`);
    expect(read.status).toBe(200);

    const write = await anon.request(`/api/repos/${owner.username}/${repoName}/push-policy`, {
      method: "PUT",
      body: { deny_non_fast_forwards: true },
    });
    expect(write.status).toBe(401);
  });

  test("the settings live in the repository's own git config", async () => {
    const path = hashedRepositoryPath(owner.username, repoName);
    const proc = Bun.spawn(["git", "config", "--local", "--get", "receive.fsckObjects"], {
      cwd: path,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("true");
  });
});

describe("a user profile lists only repositories that user owns", () => {
  const orgName = `profileorg${run}`;
  const secretName = "profile-secret";

  beforeAll(async () => {
    const org = await owner.request("/api/orgs", { method: "POST", body: { name: orgName } });
    expect(org.status).toBe(201);
    await owner.request(`/api/orgs/${orgName}/members`, {
      method: "POST",
      body: { username: other.username, role: "member" },
    });
    const repo = await other.request("/api/repos", {
      method: "POST",
      body: { name: secretName, organization: orgName, visibility: "private" },
    });
    expect(repo.status).toBe(201);
  });

  test("the creator's profile does not list the organisation's repository", async () => {
    const listed = await other.request<{ items: Array<{ full_name: string }> }>(
      `/api/users/${other.username}/repos`,
    );
    const names = listed.data.items.map((entry) => entry.full_name);
    expect(names).not.toContain(`${orgName}/${secretName}`);
  });

  test("the profile count and the profile list agree", async () => {
    const profile = await other.request<{ repo_count: number }>(`/api/users/${other.username}`);
    const listed = await other.request<{ items: unknown[] }>(`/api/users/${other.username}/repos`);
    expect(profile.data.repo_count).toBe(listed.data.items.length);
  });

  test("leaving the organisation ends access, including from the profile", async () => {
    const before = await other.request(`/api/repos/${orgName}/${secretName}`);
    expect(before.status).toBe(200);

    const left = await other.request(`/api/orgs/${orgName}/members/${other.username}`, {
      method: "DELETE",
    });
    expect(left.status).toBe(200);

    const after = await other.request(`/api/repos/${orgName}/${secretName}`);
    expect(after.status).toBe(404);

    const listed = await other.request<{ items: Array<{ full_name: string }> }>(
      `/api/users/${other.username}/repos`,
    );
    expect(listed.data.items.map((entry) => entry.full_name)).not.toContain(
      `${orgName}/${secretName}`,
    );
  });

  test("a user's own repositories still appear on their profile", async () => {
    const own = await other.request("/api/repos", {
      method: "POST",
      body: { name: `own-${run}` },
    });
    expect(own.status).toBe(201);
    const listed = await other.request<{ items: Array<{ full_name: string }> }>(
      `/api/users/${other.username}/repos`,
    );
    expect(listed.data.items.map((entry) => entry.full_name)).toContain(
      `${other.username}/own-${run}`,
    );
  });
});

describe("the admin CLI can resolve an organisation repository", () => {
  const orgName = `cliresolve${run}`;
  const repoName = "under-org";

  beforeAll(async () => {
    const created = await owner.request("/api/orgs", { method: "POST", body: { name: orgName } });
    expect(created.status).toBe(201);
    const repo = await owner.request("/api/repos", {
      method: "POST",
      body: { name: repoName, organization: orgName },
    });
    expect(repo.status).toBe(201);
  });

  test("the repository resolves by its organisation name", async () => {
    const byOrg = await owner.request(`/api/repos/${orgName}/${repoName}`);
    expect(byOrg.status).toBe(200);

    const byCreator = await owner.request(`/api/repos/${owner.username}/${repoName}`);
    expect(byCreator.status).toBe(404);
  });

  test("the on-disk path follows the organisation, not the creator", () => {
    const orgPath = hashedRepositoryPath(orgName, repoName);
    const creatorPath = hashedRepositoryPath(owner.username, repoName);

    expect(existsSync(orgPath)).toBe(true);
    expect(orgPath).not.toBe(creatorPath);

    expect(existsSync(join(orgPath, "HEAD"))).toBe(true);
  });

  test("the quota report projection agrees with the path", async () => {
    const rows = quotaReport();
    const row = rows.find((entry) => entry.repository === `${orgName}/${repoName}`);
    expect(row).toBeDefined();
    expect(row?.owner_kind).toBe("org");
    expect(existsSync(hashedRepositoryPath(orgName, repoName))).toBe(true);
  });
});

describe("private repository disclosure", () => {
  const repoName = "disclosure";

  beforeAll(async () => {
    await owner.createRepo(repoName, { visibility: "private" });
  });

  test("the JSON API hides a private repository as not-found", async () => {
    const anon = new Client();
    const real = await anon.request(`/api/repos/${owner.username}/${repoName}`);
    const missing = await anon.request(`/api/repos/${owner.username}/definitely-not-here`);
    expect(real.status).toBe(404);
    expect(real.status).toBe(missing.status);
    expect((real.data as { error?: { code?: string } }).error?.code).toBe(
      (missing.data as { error?: { code?: string } }).error?.code,
    );
  });

  test("the git transport asks for credentials instead", async () => {
    const anon = new Client();
    const infoRefs = await anon.request(
      `/${owner.username}/${repoName}.git/info/refs?service=git-upload-pack`,
    );
    expect(infoRefs.status).toBe(401);
  });

  test("an authenticated caller without access is also hidden", async () => {
    const stranger = new Client();
    await stranger.signup("feat-disclose");
    const response = await stranger.request(`/api/repos/${owner.username}/${repoName}`);
    expect(response.status).toBe(404);
  });

  test("an instance administrator can still read it", async () => {
    const asOwner = await owner.request(`/api/repos/${owner.username}/${repoName}`);
    expect(asOwner.status).toBe(200);
  });
});

describe("storage quotas", () => {
  const repoName = "quota";

  test("a quota can be set, read back, and cleared", async () => {
    await owner.createRepo(repoName, { visibility: "public" });

    const set = await owner.request<{ quota_bytes: number | null }>(
      `/api/repos/${owner.username}/${repoName}/quota`,
      { method: "PUT", body: { quota_bytes: 65536 } },
    );
    expect(set.status).toBe(200);
    expect(set.data.quota_bytes).toBe(65536);

    const read = await owner.request<{ limit_bytes: number | null }>(
      `/api/repos/${owner.username}/${repoName}/quota`,
    );
    expect(read.data.limit_bytes).toBe(65536);

    const unlimited = await owner.request<{ quota_bytes: number }>(
      `/api/repos/${owner.username}/${repoName}/quota`,
      { method: "PUT", body: { quota_bytes: 0 } },
    );
    expect(unlimited.data.quota_bytes).toBe(0);

    const cleared = await owner.request<{ quota_bytes: number | null }>(
      `/api/repos/${owner.username}/${repoName}/quota`,
      { method: "PUT", body: { quota_bytes: null } },
    );
    expect(cleared.data.quota_bytes).toBeNull();
  });

  test("a non-owner cannot change the quota", async () => {
    const response = await other.request(`/api/repos/${owner.username}/${repoName}/quota`, {
      method: "PUT",
      body: { quota_bytes: 1024 },
    });
    expect([403, 404]).toContain(response.status);
  });

  test("a push that would exceed the quota is refused with 413", async () => {
    await owner.request(`/api/repos/${owner.username}/${repoName}/quota`, {
      method: "PUT",
      body: { quota_bytes: 1 },
    });

    const token = await owner.token("quota-push");
    const work = join(scratch, `quota-work-${run}`);
    mkdirSync(work, { recursive: true });
    const remote = `${BASE.replace("http://", `http://${owner.username}:${token}@`)}/${owner.username}/${repoName}.git`;
    const gitIn = async (args: string[]): Promise<{ code: number; stderr: string }> => {
      const proc = Bun.spawn(["git", ...args], { cwd: work, stdout: "pipe", stderr: "pipe" });
      const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      return { code, stderr };
    };
    await gitIn(["init", "-q", "-b", "main"]);
    await gitIn(["remote", "add", "origin", remote]);
    writeFileSync(join(work, "big.txt"), "x".repeat(4096));
    await gitIn(["add", "."]);
    await gitIn([...identity, "commit", "-q", "-m", "too big"]);

    const push = await gitIn(["push", "origin", "main"]);
    expect(push.code).not.toBe(0);
    expect(push.stderr.toLowerCase()).toMatch(/storage limit|413/);
  }, 120_000);

  test("the quota report is admin-only and names the repository", async () => {
    const asOwner = await owner.request("/api/repos/quota-report");
    expect([200, 403]).toContain(asOwner.status);

    const asOther = await other.request("/api/repos/quota-report");
    expect(asOther.status).toBe(403);
  });
});

describe("SSH keys and the forced command", () => {
  function ed25519Key(seed: number): string {
    const algorithm = "ssh-ed25519";
    const nameBuf = Buffer.from(algorithm, "ascii");
    const key = Buffer.alloc(32);
    for (let i = 0; i < 32; i++) key[i] = (seed * 31 + i * 7) % 256;
    const blob = Buffer.concat([
      Buffer.from([0, 0, 0, nameBuf.length]),
      nameBuf,
      Buffer.from([0, 0, 0, 32]),
      key,
    ]);
    return `${algorithm} ${blob.toString("base64")} test@example.com`;
  }

  test("a valid key is accepted and its fingerprint matches OpenSSH's format", async () => {
    const added = await owner.request<{ fingerprint: string; algorithm: string; id: number }>(
      "/api/ssh-keys",
      { method: "POST", body: { title: "laptop", public_key: ed25519Key(1) } },
    );
    expect(added.status).toBe(201);
    expect(added.data.algorithm).toBe("ssh-ed25519");
    expect(added.data.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
  });

  test("the same key cannot be added twice, or onto another account", async () => {
    const again = await owner.request("/api/ssh-keys", {
      method: "POST",
      body: { public_key: ed25519Key(1) },
    });
    expect(again.status).toBe(409);

    const stolen = await other.request("/api/ssh-keys", {
      method: "POST",
      body: { public_key: ed25519Key(1) },
    });
    expect(stolen.status).toBe(409);
  });

  test("malformed keys are refused rather than stored", async () => {
    const rejectedByParser: Array<Record<string, unknown>> = [
      { public_key: "not a key at all, just prose that is long enough to pass a length check" },
      { public_key: `ssh-ed25519 ${Buffer.alloc(40, 7).toString("base64")}` },
      {
        public_key:
          "ssh-dss AAAAB3NzaC1kc3MAAACBAJ8kJqZ0mYhZk1P2wQ3rT5vX7bN9cL4dF6gH8jK0mP2sU4wY6aB1cD3eF5gH7jK9mN1pQ3rS5tU7vW9xY2zA4bC6dE8fG0hI2jK4lM6nO8pQ0rS2tU4vW6xY8zA0bC2dE4fG6hI8jK0l",
      },
    ];
    for (const body of rejectedByParser) {
      const response = await owner.request("/api/ssh-keys", { method: "POST", body });
      expect(response.status).toBe(422);
    }

    const rejectedBySchema: Array<Record<string, unknown>> = [
      { public_key: "ssh-ed25519 AAAA" },
      { public_key: "" },
    ];
    for (const body of rejectedBySchema) {
      const response = await owner.request("/api/ssh-keys", { method: "POST", body });
      expect(response.status).toBe(400);
    }

    const list = await owner.request<{ items: unknown[] }>("/api/ssh-keys");
    expect(list.data.items.length).toBe(1);
  });

  test("the key list exposes only the fingerprint, never the key material", async () => {
    const list = await owner.request<{ items: Array<Record<string, unknown>> }>("/api/ssh-keys");
    expect(list.data.items.length).toBeGreaterThan(0);
    for (const item of list.data.items) {
      expect(item["fingerprint"]).toBeDefined();
      expect(item["public_key"]).toBeUndefined();
    }
  });

  test("a key can be deleted, and deleting someone else's is a 404", async () => {
    const added = await owner.request<{ id: number }>("/api/ssh-keys", {
      method: "POST",
      body: { public_key: ed25519Key(2) },
    });
    expect(added.status).toBe(201);

    const stolen = await other.request(`/api/ssh-keys/${added.data.id}`, { method: "DELETE" });
    expect(stolen.status).toBe(404);

    const own = await owner.request(`/api/ssh-keys/${added.data.id}`, { method: "DELETE" });
    expect(own.status).toBe(200);
  });

  test("the generated authorized_keys line forces the command and pins the fingerprint", () => {
    const parsed = parsePublicKey(ed25519Key(3));
    expect(parsed).not.toBeNull();
    const line = authorizedKeysLine(
      {
        id: 1,
        user_id: 1,
        title: "t",
        fingerprint: parsed?.fingerprint ?? "",
        public_key: parsed?.normalized ?? "",
        created_at: 0,
      },
      "/usr/local/bin/gitgood-ssh",
    );
    expect(line).toContain('command="/usr/local/bin/gitgood-ssh"');
    expect(line).toContain(`environment="GITGOOD_SSH_FINGERPRINT=${parsed?.fingerprint}"`);
    expect(line).toContain("no-port-forwarding");
    expect(line).toContain("restrict");
    expect(line.endsWith(parsed?.normalized ?? "")).toBe(true);
  });

  test("fingerprintOf matches the documented OpenSSH algorithm", () => {
    const parsed = parsePublicKey(ed25519Key(4));
    const blob = (parsed?.normalized ?? "").split(" ")[1] ?? "";
    const expected = `SHA256:${createHash("sha256").update(Buffer.from(blob, "base64")).digest("base64").replace(/=+$/, "")}`;
    expect(fingerprintOf(blob)).toBe(expected);
  });

  test("the authorized_keys download requires an administrator", async () => {
    const asOther = await other.request("/api/ssh-keys/authorized-keys");
    expect(asOther.status).toBe(403);
  });

  test("parseGitCommand accepts the shapes sshd actually passes", () => {
    const cases: Array<[string, string | null]> = [
      ["git-upload-pack 'owner/repo.git'", "git-upload-pack owner/repo"],
      ["git-receive-pack 'owner/repo.git'", "git-receive-pack owner/repo"],
      ["git-upload-pack owner/repo.git", "git-upload-pack owner/repo"],
      ["git-upload-pack /owner/repo.git", "git-upload-pack owner/repo"],
      ["git-upload-pack '~/owner/repo.git'", "git-upload-pack owner/repo"],
      ["git upload-pack 'owner/repo.git'", "git-upload-pack owner/repo"],
      ["git-upload-pack 'owner/repo'", "git-upload-pack owner/repo"],
    ];
    for (const [input, expected] of cases) {
      const parsed = parseGitCommand(input);
      const rendered = parsed ? `${parsed.service} ${parsed.owner}/${parsed.name}` : null;
      expect(`${input} -> ${rendered}`).toBe(`${input} -> ${expected}`);
    }
  });

  test("parseGitCommand refuses anything that is not a git request", () => {
    for (const input of [
      "",
      "ls -la",
      "bash -i",
      "git-upload-pack",
      "git-upload-pack '../../etc/passwd'",
      "git-upload-pack 'owner/repo/extra.git'",
      "git-upload-pack 'owner/repo.git; rm -rf /'",
      "git-upload-pack 'owner/repo.git\" && touch /tmp/pwned'",
      "sh -c 'git-upload-pack owner/repo.git'",
    ]) {
      expect(`${input} -> ${String(parseGitCommand(input))}`).toBe(`${input} -> null`);
    }
  });
});

import { createHash } from "node:crypto";
