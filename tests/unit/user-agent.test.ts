import { expect, test } from "bun:test";
import { describeUserAgent } from "../../src/web/user-agent.ts";

test("user agents are summarised as browser on OS, with mobile detection and safe fallbacks", () => {
  expect(describeUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36")).toEqual({ label: "Chrome on Windows", mobile: false });
  expect(describeUserAgent("Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/141.0 Safari/537.36 Edg/141.0")).toEqual({ label: "Edge on Windows", mobile: false });
  expect(describeUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1")).toEqual({ label: "Safari on iOS", mobile: true });
  expect(describeUserAgent("Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0").label).toBe("Firefox on Linux");
  expect(describeUserAgent("git/2.47.0").label).toBe("Git");
  expect(describeUserAgent(null)).toEqual({ label: "Unknown device", mobile: false });
  expect(describeUserAgent("x".repeat(100)).label.length).toBeLessThanOrEqual(58);
});
