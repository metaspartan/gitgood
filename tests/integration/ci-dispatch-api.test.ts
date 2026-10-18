import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer } from "../../src/server.ts";
import { findRepo } from "../../src/data/repos.ts";
import { appendLog, createRun, finishRun, getRun, readLog } from "../../src/ci/store.ts";
import { resetSchedulerForTests, schedulerStats, setSchedulerWorkerForTests, whenSchedulerIdle } from "../../src/ci/scheduler.ts";

const server = createServer(0), base = `http://127.0.0.1:${server.port}`;
const stamp = Date.now().toString(36), name = `dispatch${stamp}`;
let cookie = "", token = "", previousMode: string | undefined;
const prefix = `/api/repos/${name}/actions`;
async function request(path: string, method = "GET", body?: unknown, auth: "owner" | "read" | "anonymous" = "owner") {
  const response = await fetch(base + path, { method, headers: { ...(auth === "owner" ? { cookie } : auth === "read" ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const setCookie = response.headers.get("set-cookie"); if (setCookie) cookie = setCookie.split(";")[0]!;
  return { status: response.status, data: await response.json() };
}
const workflow = "name: Manual\non: workflow_dispatch\njobs:\n  build:\n    runs-on: host\n    steps:\n      - run: echo original\n";
const commit = (content: string) => request(`${prefix}/contents`, "PUT", { branch: "main", path: ".gitgood-ci.yml", content, encoding: "utf8" });
beforeAll(async () => {
  previousMode = process.env.GITGOOD_CI_MODE; process.env.GITGOOD_CI_MODE = "disabled";
  expect((await request("/api/auth/signup", "POST", { username: name, email: `${name}@example.test`, password: "dispatch-test-password" })).status).toBe(201);
  expect((await request("/api/repos", "POST", { name: "actions", visibility: "private" })).status).toBe(201);
  expect((await commit(workflow)).status).toBe(201);
  const result = await request("/api/tokens", "POST", { name: "readonly", scopes: ["read"] }); token = result.data.token;
});
afterAll(async () => { await whenSchedulerIdle(); resetSchedulerForTests(); if (previousMode === undefined) delete process.env.GITGOOD_CI_MODE; else process.env.GITGOOD_CI_MODE = previousMode; server.stop(true); });

test("disabled dispatch does not enqueue; private and read-token access fail closed", async () => {
  const before = schedulerStats().started;
  expect((await request(`${prefix}/ci/workflow`, "GET", undefined, "anonymous")).status).toBe(404);
  expect((await request(`${prefix}/ci/dispatch`, "POST", { ref: "main" }, "anonymous")).status).toBe(403);
  expect((await request(`${prefix}/ci/dispatch`, "POST", { ref: "main" }, "read")).status).toBe(403);
  expect((await request(`${prefix}/ci/dispatch`, "POST", { ref: "main" })).status).toBe(409);
  expect((await request(`${prefix}/ci/runs`)).data.items).toHaveLength(0); expect(schedulerStats().started).toBe(before);
});

test("manual queued IDs are returned once; rerun uses original SHA after branch changes", async () => {
  process.env.GITGOOD_CI_MODE = "trusted-host";
  const captured: Array<{ id: number; sha: string; command: string; finish: () => void }> = [];
  setSchedulerWorkerForTests(item => new Promise<void>(resolve => captured.push({ id: item.runId, sha: item.sha, command: item.job.steps[0]?.run ?? "", finish: () => { appendLog(item.runId, 0, "executed fixture"); finishRun(item.runId, "success", 0); resolve(); } })));
  const info = await request(`${prefix}/ci/workflow?ref=main`); expect(info.data.can_dispatch).toBe(true);
  expect((await request(`${prefix}/ci/workflow?ref=main`, "GET", undefined, "read")).data.can_dispatch).toBe(false);
  const result = await request(`${prefix}/ci/dispatch`, "POST", { ref: "main" }); expect(result.status).toBe(202); expect(result.data.items).toHaveLength(1);
  const id = result.data.items[0].id; expect(getRun(id)?.sha).toBe(info.data.sha); expect(captured).toHaveLength(1);
  expect((await request(`${prefix}/ci/runs/${id}/rerun`, "POST")).status).toBe(409);
  captured[0]!.finish(); await whenSchedulerIdle();
  expect((await commit(workflow.replace("echo original", "echo changed"))).status).toBe(201);
  const rerun = await request(`${prefix}/ci/runs/${id}/rerun`, "POST"); expect(rerun.status).toBe(202);
  expect(captured[1]!.sha).toBe(info.data.sha); expect(captured[1]!.command).toBe("echo original"); expect(rerun.data.items[0].id).not.toBe(id);
  captured[1]!.finish(); await whenSchedulerIdle(); setSchedulerWorkerForTests(null);
  expect((await request(`${prefix}/ci/runs`)).data.items).toHaveLength(2);
});

test("unsupported workflows and absent manual opt-in do not execute", async () => {
  const before = schedulerStats().started;
  expect((await commit(workflow.replace("on: workflow_dispatch", "on: pull_request"))).status).toBe(201);
  expect((await request(`${prefix}/ci/dispatch`, "POST", { ref: "main" })).status).toBe(422);
  expect((await commit(workflow.replace("- run: echo original", "- uses: actions/checkout@v4"))).status).toBe(201);
  expect((await request(`${prefix}/ci/dispatch`, "POST", { ref: "main" })).status).toBe(422);
  expect((await request(`${prefix}/ci/dispatch`, "POST", { ref: "main", inputs: {} })).status).toBe(400);
  expect(schedulerStats().started).toBe(before);
});

test("log pagination advances beyond 500 without repeating a row or accepting negative limits", async () => {
  const repo = findRepo(name, "actions")!;
  const id = createRun({ repo_id: repo.id, workflow_name: "log", job_id: "log", ref_name: "main", sha: "a".repeat(40) });
  for (let i = 0; i < 501; i++) appendLog(id, i, `line ${i}`);
  finishRun(id, "success", 0);
  const first = await request(`${prefix}/ci/runs/${id}/log?limit=500`); expect(first.data.items).toHaveLength(500); expect(first.data.next).toBe(500);
  const second = await request(`${prefix}/ci/runs/${id}/log?after=${first.data.next}`); expect(second.data.items).toEqual([{ seq: 500, text: "line 500" }]); expect(second.data.next).toBe(501);
  expect((await request(`${prefix}/ci/runs/${id}/log?limit=-1`)).status).toBe(400);
  expect((await request(`${prefix}/ci/runs/${id}junk/log`)).status).toBe(400);
  expect(readLog(id, 500, 1)).toEqual(second.data.items);
});


test("history cursor is bounded and stable across new runs with no duplicates or omissions", async () => {
  const repo = findRepo(name, "actions")!;
  const baseline = (await request(`${prefix}/ci/runs?limit=100`)).data.items.map((r: { id: number }) => r.id) as number[];
  const created: number[] = [];
  for (let i = 0; i < 31; i++) {
    const id = createRun({ repo_id: repo.id, workflow_name: "history", job_id: String(i), ref_name: "main", sha: "b".repeat(40) });
    finishRun(id, "success", 0); created.unshift(id);
  }
  const first = (await request(`${prefix}/ci/runs`)).data;
  expect(first.items.map((r: { id: number }) => r.id)).toEqual(created.slice(0, 30));
  expect(first.next_before).toBe(created[29]);
  const inserted = createRun({ repo_id: repo.id, workflow_name: "new", job_id: "new", ref_name: "main", sha: "c".repeat(40) }); finishRun(inserted, "success", 0);
  const second = (await request(`${prefix}/ci/runs?before=${first.next_before}`)).data;
  expect(second.items.map((r: { id: number }) => r.id)).toEqual([...created.slice(30), ...baseline]);
  expect(second.next_before).toBeNull();
  expect((await request(`${prefix}/ci/runs`)).data.items[0].id).toBe(inserted);
  for (const limit of [29, 30, 31]) expect((await request(`${prefix}/ci/runs?limit=${limit}`)).data.items).toHaveLength(limit);
  for (const query of ["before=0", "before=-1", "before=1junk", "before=9007199254740992", "limit=-1", "limit=oops"]) expect((await request(`${prefix}/ci/runs?${query}`)).status).toBe(400);
  expect((await request(`${prefix}/ci/runs?before=${first.next_before}`, "GET", undefined, "anonymous")).status).toBe(404);
  const old = (await request(`${prefix}/ci/runs/${created[30]}`)).data;
  expect(old.id).toBe(created[30]); expect(old.status).toBe("success");
  for (let i = 0; i < 100; i++) { const id = createRun({ repo_id: repo.id, workflow_name: "cap", job_id: String(i), ref_name: "main", sha: "d".repeat(40) }); finishRun(id, "success", 0); }
  for (const limit of [99, 100, 101]) expect((await request(`${prefix}/ci/runs?limit=${limit}`)).data.items).toHaveLength(Math.min(limit, 100));
});
