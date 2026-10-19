import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../src/server.ts";
import { git } from "../../src/git/run.ts";
import { dayKey } from "../../src/data/activity.ts";

const scratch = mkdtempSync(join(tmpdir(), "gg-activity-test-"));
const server = createServer(0);
const BASE = `http://127.0.0.1:${server.port}`;
const stamp = Date.now().toString(36);
const owner = `ca${stamp}`;
const other = `cb${stamp}`;
const PASSWORD = "comments-activity-password";
const identityFor = (email: string) => ["-c", "user.name=Activity", "-c", `user.email=${email}`];

class Client {
  cookie = "";
  async call<T = any>(path: string, method = "GET", body?: unknown): Promise<{ status: number; data: T }> {
    const response = await fetch(BASE + path, {
      method,
      headers: { ...(this.cookie ? { cookie: this.cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) this.cookie = setCookie.split(";")[0]!;
    const text = await response.text();
    return { status: response.status, data: (text ? JSON.parse(text) : null) as T };
  }
}

const me = new Client();
const them = new Client();
const anon = new Client();
type Reaction = { content: string; count: number; me: boolean };
type CommentJson = { id: number; body: string; updated_at: number | null; reactions: Reaction[] };
let commentId = 0;
let theirCommentId = 0;

beforeAll(async () => {
  await me.call("/api/auth/signup", "POST", { username: owner, email: `${owner}@example.test`, password: PASSWORD });
  await them.call("/api/auth/signup", "POST", { username: other, email: `${other}@example.test`, password: PASSWORD });
  expect((await me.call("/api/repos", "POST", { name: "proj" })).status).toBe(201);
  expect((await me.call("/api/repos", "POST", { name: "secret", visibility: "private" })).status).toBe(201);
  expect((await me.call("/api/repos/" + owner + "/proj/issues", "POST", { title: "First", body: "hello" })).status).toBe(201);
  commentId = (await me.call<{ id: number }>(`/api/repos/${owner}/proj/issues/1/comments`, "POST", { body: "mine" })).data.id;
  theirCommentId = (await them.call<{ id: number }>(`/api/repos/${owner}/proj/issues/1/comments`, "POST", { body: "theirs" })).data.id;

  const token = (await me.call<{ token: string }>("/api/tokens", "POST", { name: "push" })).data.token;
  for (const [repo, files] of [["proj", 3], ["secret", 2]] as const) {
    const work = join(scratch, repo);
    mkdirSync(work, { recursive: true });
    await git(["init", "-q", "-b", "main", work], { cwd: work });
    await git(["remote", "add", "origin", `${BASE.replace("http://", `http://${owner}:${token}@`)}/${owner}/${repo}.git`], { cwd: work });
    for (let i = 0; i < files; i += 1) {
      writeFileSync(join(work, `f${i}.txt`), `${i}\n`);
      await git(["add", "."], { cwd: work });
      await git([...identityFor(`${owner}@example.test`), "commit", "-q", "-m", `c${i}`], { cwd: work });
    }
    await git(["push", "-q", "origin", "main"], { cwd: work });
  }
  const work = join(scratch, "proj");
  writeFileSync(join(work, "later.txt"), "later\n");
  await git(["add", "."], { cwd: work });
  await git([...identityFor(`${owner.toUpperCase()}@EXAMPLE.TEST`), "commit", "-q", "-m", "later"], { cwd: work });
  writeFileSync(join(work, "someone-else.txt"), "x\n");
  await git(["add", "."], { cwd: work });
  await git([...identityFor("stranger@example.com"), "commit", "-q", "-m", "not mine"], { cwd: work });
  await git(["push", "-q", "origin", "main"], { cwd: work });
  for (let i = 0; i < 100; i += 1) {
    const calendar = await me.call<{ breakdown: { commits: number } }>(`/api/users/${owner}/contributions`);
    if (calendar.data.breakdown.commits >= 6) break;
    await Bun.sleep(50);
  }
}, 120_000);

afterAll(() => {
  server.stop(true);
  rmSync(scratch, { recursive: true, force: true });
});

const comments = (client: Client) => client.call<{ items: CommentJson[] }>(`/api/repos/${owner}/proj/issues/1/comments`);

describe("comment editing and deletion", () => {
  test("the author can edit and the comment is marked edited", async () => {
    const edited = await me.call<CommentJson>(`/api/repos/${owner}/proj/comments/${commentId}`, "PATCH", { body: "mine, edited" });
    expect(edited.status).toBe(200);
    expect(edited.data.body).toBe("mine, edited");
    expect(edited.data.updated_at).toBeGreaterThan(0);
  });

  test("someone else cannot edit or delete a comment they did not write in a repository they cannot write to", async () => {
    expect((await them.call(`/api/repos/${owner}/proj/comments/${commentId}`, "PATCH", { body: "hijack" })).status).toBe(403);
    expect((await them.call(`/api/repos/${owner}/proj/comments/${commentId}`, "DELETE")).status).toBe(403);
    expect((await anon.call(`/api/repos/${owner}/proj/comments/${commentId}`, "DELETE")).status).toBe(401);
  });

  test("a comment id from another repository is a 404", async () => {
    expect((await me.call(`/api/repos/${owner}/secret/comments/${commentId}`, "PATCH", { body: "x" })).status).toBe(404);
  });

  test("the repository owner can moderate someone else's comment", async () => {
    expect((await me.call(`/api/repos/${owner}/proj/comments/${theirCommentId}`, "DELETE")).status).toBe(204);
    expect((await comments(me)).data.items.map((c) => c.id)).toEqual([commentId]);
  });
});

describe("reactions", () => {
  test("adding is idempotent, counts per viewer, and removal works", async () => {
    await them.call(`/api/repos/${owner}/proj/comments/${commentId}/reactions`, "PUT", { content: "heart" });
    await them.call(`/api/repos/${owner}/proj/comments/${commentId}/reactions`, "PUT", { content: "heart" });
    const mine = await me.call<{ reactions: Reaction[] }>(`/api/repos/${owner}/proj/comments/${commentId}/reactions`, "PUT", { content: "heart" });
    expect(mine.data.reactions).toEqual([{ content: "heart", count: 2, me: true }]);
    await me.call(`/api/repos/${owner}/proj/comments/${commentId}/reactions`, "PUT", { content: "+1" });
    const listed = (await comments(them)).data.items[0]!.reactions;
    expect(listed).toEqual([{ content: "+1", count: 1, me: false }, { content: "heart", count: 2, me: true }]);
    const removed = await me.call<{ reactions: Reaction[] }>(`/api/repos/${owner}/proj/comments/${commentId}/reactions/heart`, "DELETE");
    expect(removed.data.reactions).toEqual([{ content: "+1", count: 1, me: true }, { content: "heart", count: 1, me: false }]);
  });

  test("unknown reactions and anonymous callers are refused", async () => {
    expect((await me.call(`/api/repos/${owner}/proj/comments/${commentId}/reactions`, "PUT", { content: "fire" })).status).toBe(400);
    expect((await me.call(`/api/repos/${owner}/proj/comments/${commentId}/reactions/fire`, "DELETE")).status).toBe(400);
    expect((await anon.call(`/api/repos/${owner}/proj/comments/${commentId}/reactions`, "PUT", { content: "+1" })).status).toBe(401);
  });

  test("reactions on a private repository's comments are masked from outsiders", async () => {
    await me.call(`/api/repos/${owner}/secret/issues`, "POST", { title: "Hidden" });
    const hidden = (await me.call<{ id: number }>(`/api/repos/${owner}/secret/issues/1/comments`, "POST", { body: "hidden" })).data.id;
    expect((await them.call(`/api/repos/${owner}/secret/comments/${hidden}/reactions`, "PUT", { content: "+1" })).status).toBe(404);
  });
});

type Calendar = {
  total: number;
  year: number | null;
  years: number[];
  from: string;
  to: string;
  breakdown: { commits: number; issues: number; pulls: number; comments: number; repositories: number; private: number };
  days: { date: string; count: number }[];
  months: { month: string; commits: { repo: string; count: number }[]; repositories: { repo: string }[]; issues: { repo: string; count: number }[]; private: number }[];
};

describe("contribution calendar", () => {
  test("commits come from git history by the account's email, case-insensitively, plus issues, comments and created repositories", async () => {
    const calendar = await me.call<Calendar>(`/api/users/${owner}/contributions`);
    expect(calendar.status).toBe(200);
    expect(calendar.data.breakdown).toEqual({ commits: 6, issues: 2, pulls: 0, comments: 2, repositories: 2, private: 0 });
    expect(calendar.data.total).toBe(12);
    expect(calendar.data.days.at(-1)).toEqual({ date: dayKey(Date.now(), 0), count: 12 });
    expect(new Date(`${calendar.data.days[0]!.date}T00:00:00Z`).getUTCDay()).toBe(0);
    expect(calendar.data.days.length).toBeGreaterThanOrEqual(365);
    expect(calendar.data.days.length).toBeLessThanOrEqual(371);
  });

  test("the activity timeline groups the month by repository", async () => {
    const month = (await me.call<Calendar>(`/api/users/${owner}/contributions`)).data.months[0]!;
    expect(month.month).toBe(dayKey(Date.now(), 0).slice(0, 7));
    expect(month.commits).toEqual([{ repo: `${owner}/proj`, count: 4 }, { repo: `${owner}/secret`, count: 2 }]);
    expect(month.repositories.map((r) => r.repo).sort()).toEqual([`${owner}/proj`, `${owner}/secret`]);
  });

  test("other people only see contributions to repositories they can read", async () => {
    for (const viewer of [them, anon]) {
      const calendar = await viewer.call<Calendar>(`/api/users/${owner}/contributions`);
      expect(calendar.data.breakdown).toEqual({ commits: 4, issues: 1, pulls: 0, comments: 1, repositories: 1, private: 0 });
      expect(JSON.stringify(calendar.data.months)).not.toContain("secret");
    }
  });

  test("a calendar year can be selected and the available years are listed", async () => {
    const thisYear = Number(dayKey(Date.now(), 0).slice(0, 4));
    const current = await me.call<Calendar>(`/api/users/${owner}/contributions?year=${thisYear}`);
    expect(current.data).toMatchObject({ year: thisYear, from: `${thisYear}-01-01`, to: `${thisYear}-12-31` });
    expect(current.data.years[0]).toBe(thisYear);
    const past = await me.call<Calendar>(`/api/users/${owner}/contributions?year=${thisYear - 3}`);
    expect(past.data.total).toBe(0);
    expect(past.data.months).toEqual([]);
  });

  test("the time-zone offset shifts day boundaries and is clamped", async () => {
    const shifted = await me.call<Calendar>(`/api/users/${owner}/contributions?tz=840`);
    expect(shifted.data.days.at(-1)!.date).toBe(dayKey(Date.now(), 840));
    expect((await me.call(`/api/users/${owner}/contributions?tz=99999&year=abc`)).status).toBe(200);
    expect((await anon.call(`/api/users/nobody${stamp}/contributions`)).status).toBe(404);
  });
});

describe("profile details, pins and profile README", () => {
  test("bio, company, location and website are saved, trimmed and validated", async () => {
    const saved = await me.call<{ user: Record<string, string> }>("/api/account", "PATCH", { bio: "  Builds   things  ", company: "Acme", location: "Utah", website: "example.com/me" });
    expect(saved.status).toBe(200);
    expect(saved.data.user).toMatchObject({ bio: "Builds things", company: "Acme", location: "Utah", website: "https://example.com/me" });
    expect((await me.call("/api/account", "PATCH", { website: "javascript:alert(1)" })).status).toBe(400);
    expect((await me.call("/api/account", "PATCH", { website: "https://user:pass@example.com" })).status).toBe(400);
    expect((await me.call("/api/account", "PATCH", { bio: "x".repeat(161) })).status).toBe(400);
    const profile = await anon.call<Record<string, unknown>>(`/api/users/${owner}`);
    expect(profile.data).toMatchObject({ bio: "Builds things", website: "https://example.com/me", has_profile_readme: false });
    expect(JSON.stringify(profile.data)).not.toContain("@example.test");
  });

  test("a repository named after the user becomes the profile README, if the viewer can read it", async () => {
    expect((await me.call("/api/repos", "POST", { name: owner, visibility: "private" })).status).toBe(201);
    expect((await me.call<{ has_profile_readme: boolean }>(`/api/users/${owner}`)).data.has_profile_readme).toBe(true);
    expect((await anon.call<{ has_profile_readme: boolean }>(`/api/users/${owner}`)).data.has_profile_readme).toBe(false);
  });

  test("pins keep their order, are capped at six, and hide private repositories from outsiders", async () => {
    const ids: Record<string, number> = {};
    for (const name of ["proj", "secret"]) ids[name] = (await me.call<{ id: number }>(`/api/repos/${owner}/${name}`)).data.id;
    const set = await me.call<{ repo_ids: number[] }>("/api/user/pins", "PUT", { repo_ids: [ids.secret!, ids.proj!] });
    expect(set.data.repo_ids).toEqual([ids.secret!, ids.proj!]);
    expect((await me.call<{ items: { name: string }[] }>(`/api/users/${owner}/pins`)).data.items.map((r) => r.name)).toEqual(["secret", "proj"]);
    expect((await anon.call<{ items: { name: string }[] }>(`/api/users/${owner}/pins`)).data.items.map((r) => r.name)).toEqual(["proj"]);
    expect((await me.call("/api/user/pins", "PUT", { repo_ids: [1, 2, 3, 4, 5, 6, 7] })).status).toBe(400);
    expect((await them.call("/api/user/pins", "PUT", { repo_ids: [ids.secret!] })).status).toBe(404);
    expect((await anon.call("/api/user/pins", "PUT", { repo_ids: [] })).status).toBe(401);
  });
});

describe("commit emails", () => {
  const commits = async () => (await me.call<Calendar>(`/api/users/${owner}/contributions`)).data.breakdown.commits;

  test("adding a commit email counts commits authored with it, and removing it stops counting them", async () => {
    expect(await commits()).toBe(6);
    const added = await me.call<{ items: string[]; primary: string }>("/api/account/emails", "POST", { email: "Stranger@Example.com" });
    expect(added.status).toBe(201);
    expect(added.data.items).toEqual(["Stranger@Example.com"]);
    expect(await commits()).toBe(7);
    expect((await me.call(`/api/account/emails/${encodeURIComponent("stranger@example.com")}`, "DELETE")).status).toBe(200);
    expect(await commits()).toBe(6);
  });

  test("an email can only belong to one account and must be valid", async () => {
    await me.call("/api/account/emails", "POST", { email: "shared@example.com" });
    expect((await them.call("/api/account/emails", "POST", { email: "SHARED@example.com" })).status).toBe(409);
    expect((await them.call("/api/account/emails", "POST", { email: `${owner}@example.test` })).status).toBe(409);
    expect((await me.call("/api/account/emails", "POST", { email: `${owner}@example.test` })).status).toBe(409);
    expect((await me.call("/api/account/emails", "POST", { email: "not an email" })).status).toBe(400);
    expect((await them.call(`/api/account/emails/${encodeURIComponent("shared@example.com")}`, "DELETE")).status).toBe(404);
    expect((await anon.call("/api/account/emails")).status).toBe(401);
  });

  test("commit emails are never exposed on the public profile", async () => {
    const profile = await anon.call(`/api/users/${owner}`);
    expect(JSON.stringify(profile.data)).not.toContain("shared@example.com");
  });
});

describe("suggested commit emails and private contribution counts", () => {
  test("suggestions list unclaimed author emails from the user's own repositories, most commits first", async () => {
    const mine = await me.call<{ items: { email: string; name: string; commits: number }[] }>("/api/account/emails/suggestions");
    expect(mine.status).toBe(200);
    expect(mine.data.items).toEqual([{ email: "stranger@example.com", name: "Activity", commits: 1 }]);
    expect((await them.call<{ items: unknown[] }>("/api/account/emails/suggestions")).data.items).toEqual([]);
    expect((await anon.call("/api/account/emails/suggestions")).status).toBe(401);
  });

  test("an email claimed by another account is never suggested", async () => {
    expect((await them.call("/api/account/emails", "POST", { email: "stranger@example.com" })).status).toBe(201);
    expect((await me.call<{ items: unknown[] }>("/api/account/emails/suggestions")).data.items).toEqual([]);
    await them.call(`/api/account/emails/${encodeURIComponent("stranger@example.com")}`, "DELETE");
  });

  test("with private contributions shown, others see the same total but only anonymous private counts", async () => {
    const own = (await me.call<Calendar>(`/api/users/${owner}/contributions`)).data;
    const hiddenByDefault = (await anon.call<Calendar>(`/api/users/${owner}/contributions`)).data;
    expect(hiddenByDefault.breakdown.private).toBe(0);
    expect(hiddenByDefault.total).toBeLessThan(own.total);

    const saved = await me.call<{ user: { show_private_contributions: boolean } }>("/api/account", "PATCH", { show_private_contributions: true });
    expect(saved.data.user.show_private_contributions).toBe(true);
    const shown = (await anon.call<Calendar>(`/api/users/${owner}/contributions`)).data;
    expect(shown.total).toBe(own.total);
    expect(shown.breakdown.private).toBe(own.total - hiddenByDefault.total);
    expect(shown.months[0]!.private).toBeGreaterThan(0);
    expect(JSON.stringify(shown)).not.toContain("secret");
    expect(own.breakdown.private).toBe(0);

    await me.call("/api/account", "PATCH", { show_private_contributions: false });
    expect((await anon.call<Calendar>(`/api/users/${owner}/contributions`)).data.breakdown.private).toBe(0);
  });
});
