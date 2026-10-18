import { expect, test } from "bun:test";
import { applyStar, applyWatchLevel, compactCount } from "../../src/web/components/RepoSocialActions.tsx";
import { safeNextPath } from "../../src/web/pages/Auth.tsx";

const base = { watching: false, watch_level: "participating" as const, starring: false, stars: 4, watchers: 2, forks: 1 };

test("counts are compacted like GitHub", () => {
  expect([0, 999, 1000, 1250, 9999, 12_345, 1_500_000].map(compactCount)).toEqual(["0", "999", "1k", "1.3k", "10k", "12k", "1.5m"]);
});

test("optimistic star and watch updates adjust counts exactly once", () => {
  expect(applyStar(base, true)).toMatchObject({ starring: true, stars: 5 });
  expect(applyStar(applyStar(base, true), true).stars).toBe(5);
  expect(applyStar({ ...base, starring: true, stars: 0 }, false).stars).toBe(0);
  expect(applyWatchLevel(base, "all")).toMatchObject({ watching: true, watchers: 3 });
  expect(applyWatchLevel({ ...base, watch_level: "all", watching: true }, "ignore")).toMatchObject({ watching: false, watchers: 1 });
  expect(applyWatchLevel(base, "ignore").watchers).toBe(2);
});

test("post-login redirects stay on this site", () => {
  expect(safeNextPath("/acme/app")).toBe("/acme/app");
  for (const bad of [null, "", "https://evil.test", "//evil.test", "/\\evil.test", "javascript:alert(1)", "/a b"]) expect(safeNextPath(bad)).toBe("/");
});
