import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { db, migrate } from "../../src/db/index.ts";
import { putBranchProtection } from "../../src/data/branch-protection.ts";
import { receivePackEnforcement, trustedHooksDirectory } from "../../src/git/branch-protection-hook.ts";

migrate();
function fixture() {
  const name = `hook${crypto.randomUUID().replaceAll("-", "").slice(0, 15)}`;
  const user = db.query("INSERT INTO users(username,email,password_hash,display_name,created_at) VALUES(?,?,?,?,?)").run(name, `${name}@example.test`, "test", name, Date.now());
  const repo = db.query("INSERT INTO repos(owner_id,name,created_at,updated_at) VALUES(?,?,?,?)").run(user.lastInsertRowid, "hooks", Date.now(), Date.now());
  return Number(repo.lastInsertRowid);
}

test("concurrent receive hooks are immutable distinct snapshots and cleanup is idempotent", () => {
  const id = fixture();
  putBranchProtection(id, "main", true);
  const first = receivePackEnforcement(id);
  putBranchProtection(id, "release/stable", true);
  const second = receivePackEnforcement(id);
  const a = first.configArgs[1]!.slice("core.hooksPath=".length);
  const b = second.configArgs[1]!.slice("core.hooksPath=".length);
  try {
    expect(a).not.toBe(b);
    expect(a.replaceAll("\\", "/")).toStartWith(trustedHooksDirectory().replaceAll("\\", "/"));
    expect(readFileSync(join(a, "pre-receive"), "utf8")).not.toContain("refs/heads/release/stable");
    expect(readFileSync(join(b, "pre-receive"), "utf8")).toContain("refs/heads/release/stable");
    expect(first.env.GITGOOD_PROTECTED_REFS).toBe("refs/heads/main");
    first.cleanup(); expect(existsSync(a)).toBe(false); expect(existsSync(b)).toBe(true); first.cleanup();
  } finally { first.cleanup(); second.cleanup(); }
  expect(existsSync(b)).toBe(false);
});

test("disabled rules allocate no hook and invalid exact branch names fail", () => {
  const id = fixture();
  for (const branch of ["*", "main.lock", "folder/.hidden", "main.", "/main", "main//x"]) expect(() => putBranchProtection(id, branch, true)).toThrow();
  putBranchProtection(id, "main", true); putBranchProtection(id, "main", false);
  const hook = receivePackEnforcement(id); expect(hook.configArgs).toEqual([]); expect(hook.env).toEqual({}); hook.cleanup();
});
