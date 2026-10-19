import { expect, test } from "bun:test";
import { settingsSectionFrom } from "../../src/web/components/SettingsShell.tsx";

test("settings sections come from the path and fall back to the profile", () => {
  expect(settingsSectionFrom("/settings")).toBe("profile");
  expect(settingsSectionFrom("/settings/keys")).toBe("keys");
  expect(settingsSectionFrom("/settings/tokens?x=1")).toBe("tokens");
  expect(settingsSectionFrom("/settings/security/")).toBe("security");
  expect(settingsSectionFrom("/settings/bogus")).toBe("profile");
});
