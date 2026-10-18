import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TopBar } from "../../src/web/components/TopBar.tsx";
import type { User } from "../../src/web/types.ts";

const user: User = { id: 1, username: "administrator-with-a-long-username", display_name: "Administrator", avatar_hue: 80, is_admin: true, created_at: 0 };
const render = (location: string, signedIn = true, unread = 0) => renderToStaticMarkup(<TopBar user={signedIn ? user : null} onLogout={() => {}} location={location} unread={unread} />);

test("header presents global destinations and clearly labels search", () => {
  const html = render("/");
  expect(html).toContain('aria-label="GitGood home"');
  expect(html).toContain('aria-label="Primary"');
  expect(html).toContain('aria-label="Repository search"');
  expect(html).toContain('href="/orgs"');
  expect(html).toContain('href="/notifications"');
  expect(html).toContain('aria-label="Open navigation"');
});

test("global navigation only marks its actual destination current", () => {
  expect(render("/")).toContain('aria-current="page"');
  expect(render("/orgs/acme")).toMatch(/href="\/orgs"[^>]*aria-current="page"/);
  expect(render("/notifications")).toMatch(/href="\/notifications"[^>]*aria-current="page"/);
  for (const path of ["/admin/backups", "/admin/configuration", "/orgsettings", "/search?q=repo", "/settings"])
    expect(render(path)).not.toContain('aria-current="page"');
});

test("anonymous navigation has sign in but no private account controls", () => {
  const html = render("/", false);
  expect(html).toContain('href="/login"');
  expect(html).toContain('href="/orgs"');
  expect(html).not.toContain('href="/notifications"');
  expect(html).not.toContain('Account menu for');
});

test("account disclosure starts closed without claiming menu-role semantics", () => {
  const html = render("/");
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain('aria-controls=');
  expect(html).not.toContain('aria-haspopup');
  expect(html).not.toContain('Sign out');
});

test("unread badge handles zero, exact cap and one over the cap", () => {
  expect(render("/", true, 0)).not.toContain('class="header-count"');
  expect(render("/", true, 99)).toContain('class="header-count" aria-hidden="true">99</span>');
  const html = render("/", true, 100);
  expect(html).toContain('class="header-count" aria-hidden="true">99+</span>');
  expect(html).toContain('aria-label="Notifications, 100 unread"');
});


test("notification bell is independently accessible and chevron is a vector rather than a text glyph", () => {
  const html = render("/notifications", true, 0);
  expect(html).toContain('class="header-notifications"');
  expect(html).toContain('aria-label="Notifications"');
  expect(html).toContain('class="ui-icon header-chevron"');
  expect(html).not.toContain("⌄");
  expect((html.match(/href="\/notifications"/g) ?? [])).toHaveLength(1);
  expect(html).toMatch(/class="header-notifications"[^>]*aria-current="page"/);
  expect(html).toContain('focusable="false"');
});
