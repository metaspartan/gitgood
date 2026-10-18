import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { DeploymentGuidance } from "../../src/web/components/DeploymentGuidance.tsx";

test("no empty warning section when all reported conditions are clear", () => {
  expect(renderToStaticMarkup(<DeploymentGuidance secureCookies sshConfigured privateWebhooks={false} />)).toBe("");
});
test("SSH guidance distinguishes optional Git transport from host administration", () => {
  const html = renderToStaticMarkup(<DeploymentGuidance secureCookies sshConfigured={false} privateWebhooks={false} />);
  expect(html).toContain("Git over SSH is not configured");
  expect(html).toContain("Git over HTTPS is independent");
  expect(html).toContain("administrative SSH port alone");
  expect(html).not.toContain("Development HTTP");
  expect(html).not.toContain("Private-network webhooks allowed");
  expect(html).toContain('aria-labelledby="deployment-guidance-heading"');
});
test("security-relevant warnings remain visible independently", () => {
  const html = renderToStaticMarkup(<DeploymentGuidance secureCookies={false} sshConfigured privateWebhooks />);
  expect(html).toContain("Development HTTP"); expect(html).toContain("Private-network webhooks allowed");
  expect(html).not.toContain("Git over SSH is not configured");
});
test("removed signup claim stays absent and guidance has explicit section spacing", () => {
  const auth = readFileSync(new URL("../../src/web/pages/Auth.tsx", import.meta.url), "utf8");
  expect(auth).not.toContain("The first account created becomes the instance administrator.");
  const css = readFileSync(new URL("../../src/web/components/DeploymentGuidance.css", import.meta.url), "utf8");
  expect(css).toContain("margin: 32px 0 28px"); expect(css).toContain("padding-top: 24px");
  expect(css).toContain("margin-top: 28px");
});
