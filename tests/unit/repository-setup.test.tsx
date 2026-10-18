import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RepositorySetup } from "../../src/web/components/RepositorySetup.tsx";
import { HomePage } from "../../src/web/pages/Home.tsx";
import { pushInstructions } from "../../src/web/repository-setup.ts";

const url = "https://git.example.com/team/project.git";

test("setup instructions use the selected branch in both git commands", () => {
  expect(pushInstructions(url, " release/next ")).toBe(
    "git remote add origin 'https://git.example.com/team/project.git'\ngit branch -M 'release/next'\ngit push -u origin 'release/next'",
  );
  expect(pushInstructions(url, "")).toContain("git branch -M 'main'");
  expect(pushInstructions(url, " ")).toContain("git push -u origin 'main'");
});

test("shell arguments remain quoted even with apostrophes and metacharacters", () => {
  const commands = pushInstructions("https://host/repo's.git", "feature/$name;echo");
  expect(commands).toContain("'https://host/repo'\\''s.git'");
  expect(commands).toContain("git branch -M 'feature/$name;echo'");
  expect(commands.split("\n")).toHaveLength(3);
});

test("setup cards have semantic headings, selectable commands and copy feedback", () => {
  const html = renderToStaticMarkup(<RepositorySetup cloneUrl={url} branch="trunk" />);
  expect((html.match(/class="setup-panel(?: setup-push)?"/g) ?? [])).toHaveLength(3);
  expect(html).toContain("Clone URL");
  expect(html).toContain("Push existing code");
  expect(html).toContain("Copy commands");
  expect(html).toContain('role="status"');
  expect(html).toContain("Preview");
  expect(html).not.toContain("Ready to use");
  expect(html).toContain("trunk");
  const created = renderToStaticMarkup(<RepositorySetup cloneUrl={url} branch="trunk" ready />);
  expect(created).toContain("Ready to use");
});

test("front page prioritizes repositories rather than showing placeholder clone instructions", () => {
  const html = renderToStaticMarkup(<HomePage />);
  expect(html).toContain("All repositories");
  expect(html).toContain("Sign in to create");
  expect(html).not.toContain("Repository setup guide");
  expect(html).not.toContain('class="create-form"');
});
