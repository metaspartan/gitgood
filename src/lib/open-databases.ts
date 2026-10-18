import { resolve } from "node:path";

const open = new Set<string>();

export function markDatabaseOpen(path: string): void {
  open.add(resolve(path));
}

export function isDatabaseOpenHere(path: string): boolean {
  return open.has(resolve(path));
}
