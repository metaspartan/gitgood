export const REPO_NAME = /^[a-zA-Z0-9._-]{1,100}$/;

export const RESERVED_NAMES: readonly string[] = [
  ".",
  "..",
  "api",
  "assets",
  "login",
  "logout",
  "new",
  "settings",
  "notifications",
  "orgs",
  "search",
];

export const MAX_NAME_LENGTH = 100;

export function repoNameProblem(name: string): string | null {
  const value = name.trim();
  if (value.length === 0) return null;
  if (value.length > MAX_NAME_LENGTH) {
    return `Names are at most ${MAX_NAME_LENGTH} characters`;
  }
  if (!REPO_NAME.test(value)) {
    return "Use only letters, digits, dots, dashes and underscores";
  }
  if (RESERVED_NAMES.includes(value.toLowerCase())) {
    return `"${value}" is reserved`;
  }
  return null;
}

export function repoPathPreview(owner: string, name: string): string {
  const trimmed = name.trim();
  return `${owner || "you"}/${trimmed || "my-project"}`;
}
