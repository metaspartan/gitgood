import { one } from "../db/index.ts";

export function userHasInstanceAdmin(userId: number): boolean {
  const row = one<{ is_admin: number }>("SELECT is_admin FROM users WHERE id = ?", userId);
  return row?.is_admin === 1;
}
