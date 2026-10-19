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
const identity = ["-c", "user.name=Activity", "-c", "user.email=activity@example.com"];

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
      await git([...identity, "commit", "-q", "-m", `c${i}`], { cwd: work });
    }
    await git(["push", "-q", "origin", "main"], { cwd: work });
  }
  const work = join(scratch, "proj");
  writeFileSync(join(work, "later.txt"), "later\n");
  await git(["add", "."], { cwd: work });
  await git([...identity, "commit", "-q", "-m", "later"], { cwd: work });
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

type Calendar = { total: number; breakdown: { commits: number; issues: number; pulls: number; comments: number }; days: { date: string; count: number }[] };

describe("contribution calendar", () => {
  test("the owner sees pushed commits, issues and comments across public and private repositories", async () => {
    const calendar = await me.call<Calendar>(`/api/users/${owner}/contributions`);
    expect(calendar.status).toBe(200);
    expect(calendar.data.days.length).toBe(371);
    expect(calendar.data.breakdown).toEqual({ commits: 6, issues: 2, pulls: 0, comments: 2 });
    expect(calendar.data.total).toBe(10);
    const today = dayKey(Date.now(), 0);
    expect(calendar.data.days.at(-1)).toEqual({ date: today, count: 10 });
  });

  test("other people only see contributions to repositories they can read", async () => {
    for (const viewer of [them, anon]) {
      const calendar = await viewer.call<Calendar>(`/api/users/${owner}/contributions`);
      expect(calendar.data.breakdown).toEqual({ commits: 4, issues: 1, pulls: 0, comments: 1 });
    }
  });

  test("the time-zone offset shifts day boundaries and is clamped", async () => {
    const shifted = await me.call<Calendar>(`/api/users/${owner}/contributions?tz=840`);
    expect(shifted.data.days.at(-1)!.date).toBe(dayKey(Date.now(), 840));
    expect((await me.call(`/api/users/${owner}/contributions?tz=99999`)).status).toBe(200);
    expect((await anon.call(`/api/users/nobody${stamp}/contributions`)).status).toBe(404);
  });
});
