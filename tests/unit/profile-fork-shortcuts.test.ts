import { describe, expect, test } from "bun:test";
import { GO_SHORTCUTS, repoFromPath, resolveSequence } from "../../src/web/components/KeyboardShortcuts.tsx";
import { ownedForks } from "../../src/web/components/RepoSocialActions.tsx";
import { forkNameProblem } from "../../src/web/pages/ForkPage.tsx";
import { filterAndSortRepos, popularRepos, profileTabFrom, repoForks, repoStars } from "../../src/web/pages/User.tsx";
import type { Repo } from "../../src/web/types.ts";

const repo = (name: string, stars: number, updated: number, description = ""): Repo =>
  ({ id: updated, owner: "me", name, full_name: `me/${name}`, description, visibility: "public", updated_at: updated, stats: { stars } }) as unknown as Repo;

describe("keyboard shortcuts", () => {
  test("repository context comes from the path, not reserved top-level pages", () => {
    expect(repoFromPath("/acme/app/issues/3?x=1")).toEqual({ owner: "acme", repo: "app" });
    expect(repoFromPath("/acme/app.git")).toEqual({ owner: "acme", repo: "app" });
    for (const path of ["/", "/acme", "/admin/users", "/settings/tokens", "/orgs/acme", "/search?q=x", "/notifications/all"]) {
      expect(repoFromPath(path)).toBeNull();
    }
  });

  test("g-sequences resolve inside a repository and only the global ones outside", () => {
    expect(resolveSequence("g", "i", "/acme/app/tree/main/src")).toBe("/acme/app/issues");
    expect(resolveSequence("g", "p", "/acme/app")).toBe("/acme/app/pulls");
    expect(resolveSequence("g", "c", "/acme/app/pulls/4")).toBe("/acme/app");
    expect(resolveSequence("g", "i", "/settings")).toBeNull();
    expect(resolveSequence("g", "n", "/settings")).toBe("/notifications");
    expect(resolveSequence("g", "d", "/acme/app")).toBe("/");
    expect(resolveSequence("g", "z", "/acme/app")).toBeNull();
  });

  test("every shortcut is a distinct two-key g sequence", () => {
    const keys = GO_SHORTCUTS.map((s) => s.keys);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key).toMatch(/^g [a-z]$/);
  });
});

describe("fork helpers", () => {
  test("forks owned by me or my organisations are found case-insensitively", () => {
    const forks = [{ owner: "Me", name: "a" }, { owner: "acme", name: "b" }, { owner: "stranger", name: "c" }];
    expect(ownedForks(forks, "me", ["ACME"]).map((f) => f.name)).toEqual(["a", "b"]);
    expect(ownedForks(forks, "nobody", [])).toEqual([]);
  });

  test("fork names follow the repository naming rules", () => {
    expect(forkNameProblem("my-fork.v2_ok")).toBeNull();
    expect(forkNameProblem("")).toMatch(/required/);
    expect(forkNameProblem("has space")).toMatch(/letters/);
    expect(forkNameProblem("../escape")).toMatch(/letters/);
    expect(forkNameProblem("thing.git")).toMatch(/reserved/);
    expect(forkNameProblem("x".repeat(101))).toMatch(/letters/);
  });
});

describe("profile helpers", () => {
  test("tabs come from the query string with overview as the default", () => {
    expect(profileTabFrom("tab=stars")).toBe("stars");
    expect(profileTabFrom("tab=repositories&x=1")).toBe("repositories");
    expect(profileTabFrom("tab=bogus")).toBe("overview");
    expect(profileTabFrom("")).toBe("overview");
  });

  test("repository lists filter by name or description and sort three ways", () => {
    const list = [repo("beta", 5, 2, "a parser"), repo("alpha", 9, 1), repo("gamma", 5, 3)];
    expect(filterAndSortRepos(list, "", "updated").map((r) => r.name)).toEqual(["gamma", "beta", "alpha"]);
    expect(filterAndSortRepos(list, "", "name").map((r) => r.name)).toEqual(["alpha", "beta", "gamma"]);
    expect(filterAndSortRepos(list, "", "stars").map((r) => r.name)).toEqual(["alpha", "gamma", "beta"]);
    expect(filterAndSortRepos(list, "PARSER", "name").map((r) => r.name)).toEqual(["beta"]);
    expect(filterAndSortRepos(list, "  ", "name")).toHaveLength(3);
  });

  test("star and fork counts are read from list rows and detail records alike", () => {
    expect(repoStars({ stars: 3 } as unknown as Repo)).toBe(3);
    expect(repoStars({ stats: { stars: 4 } } as unknown as Repo)).toBe(4);
    expect(repoStars({} as Repo)).toBe(0);
    expect(repoForks({ forks: 2, stats: { forks: 9 } } as unknown as Repo)).toBe(2);
  });

  test("popular repositories are the most starred, capped, without mutating the input", () => {
    const list = Array.from({ length: 9 }, (_, i) => repo(`r${i}`, i % 4, i));
    const copy = list.map((r) => r.name);
    const top = popularRepos(list);
    expect(top).toHaveLength(6);
    expect(top[0]!.stats?.stars).toBe(3);
    expect(list.map((r) => r.name)).toEqual(copy);
  });
});
