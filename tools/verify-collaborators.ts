const root = process.env.GG_APP_ROOT ?? ".";
const { migrate } = await import(`${root}/src/db/index.ts`);
const { db } = await import(`${root}/src/db/index.ts`);
const { findRepo, canRead, canWrite, createRepository } = await import(`${root}/src/data/repos.ts`);
const { addCollaborator, listCollaborators, removeCollaborator } = await import(
  `${root}/src/data/collaborators.ts`
);

migrate();
const ok = (label: string, actual: unknown, expected: unknown): void => {
  const pass = actual === expected;
  console.log(`${pass ? "PASS" : "FAIL"} ${label}: ${String(actual)}${pass ? "" : ` (expected ${String(expected)})`}`);
  if (!pass) process.exitCode = 1;
};

const stamp = Date.now().toString(36);
const username = `synthetic${stamp}`;
const repoName = `synthetic${stamp}`;

const adminRow = db.query("SELECT id, username FROM users ORDER BY is_admin DESC, id LIMIT 1").get() as {
  id: number;
  username: string;
};
const repo = await createRepository(
  { kind: "user", userId: adminRow.id, username: adminRow.username, isAdmin: true, via: "session", scopes: ["admin"], tokenRepoId: null },
  { name: repoName, visibility: "private", description: "temporary collaborator gate audit" },
);
db.query("INSERT INTO users(username,email,password_hash,display_name,created_at) VALUES(?,?,?,?,?)").run(
  username,
  `${username}@example.test`,
  "not-a-real-hash",
  "Synthetic Audit",
  Date.now(),
);
const userId = (db.query("SELECT id FROM users WHERE username = ?").get(username) as { id: number }).id;

const asUser = { kind: "user", userId, username, isAdmin: false, via: "session", scopes: ["read", "write"], tokenRepoId: null };
const asAdmin = { kind: "user", userId: userId + 100000, username: "someoneelse", isAdmin: true, via: "session", scopes: ["admin"], tokenRepoId: null };

ok("stranger cannot read", canRead(repo, asUser), false);
ok("stranger cannot write", canWrite(repo, asUser), false);

addCollaborator(repo.id, userId, "read");
ok("read grant opens reads", canRead(repo, asUser), true);
ok("read grant does not open writes", canWrite(repo, asUser), false);
ok("grant is listed", listCollaborators(repo.id).some((c: { username: string }) => c.username === username), true);

addCollaborator(repo.id, userId, "write");
ok("upgraded to write", canWrite(repo, asUser), true);

ok("token pinned elsewhere is refused", canRead(repo, { ...asUser, via: "token", tokenRepoId: repo.id + 999 }), false);
ok("token pinned here is allowed", canRead(repo, { ...asUser, via: "token", tokenRepoId: repo.id }), true);
ok("read-only token cannot write", canWrite(repo, { ...asUser, via: "token", tokenRepoId: repo.id, scopes: ["read"] }), false);

removeCollaborator(repo.id, userId);
ok("removal revokes reads", canRead(repo, asUser), false);
ok("removal revokes writes", canWrite(repo, asUser), false);
ok("instance admin is unaffected", canWrite(repo, asAdmin), true);

db.query("DELETE FROM users WHERE id = ?").run(userId);
db.query("DELETE FROM repos WHERE id = ?").run(repo.id);
const left = db.query("SELECT COUNT(*) AS n FROM users WHERE username LIKE 'synthetic%'").get() as { n: number };
const leftRepos = db.query("SELECT COUNT(*) AS n FROM repos WHERE name LIKE 'synthetic%'").get() as { n: number };
console.log(`cleanup complete: audit users=${left.n} audit repos=${leftRepos.n}`);
console.log(`findRepo resolves: ${findRepo(adminRow.username, repoName) === null}`);
