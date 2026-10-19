import { all, now, run, scalar } from "../db/index.ts";

const RETAIN_ROWS = 50_000;

export interface AuditActor {
  userId: number;
  username: string;
}

export interface AuditEntry {
  id: number;
  actor_username: string;
  action: string;
  target: string;
  detail: string;
  ip: string;
  created_at: number;
}

export function recordAudit(actor: AuditActor, action: string, target: string, detail = "", ip = ""): void {
  run(
    "INSERT INTO admin_audit_log (actor_id, actor_username, action, target, detail, ip, created_at) VALUES ((SELECT id FROM users WHERE id = ?), ?, ?, ?, ?, ?, ?)",
    actor.userId,
    actor.username,
    action,
    target.slice(0, 200),
    detail.slice(0, 500),
    ip.slice(0, 64),
    now(),
  );
  const newest = scalar<number>("SELECT MAX(id) FROM admin_audit_log") ?? 0;
  if (newest % 1000 === 0) run("DELETE FROM admin_audit_log WHERE id <= ?", newest - RETAIN_ROWS);
}

export function listAudit(options: { query: string; limit: number; offset: number }): { items: AuditEntry[]; total: number } {
  const pattern = `%${options.query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const where = options.query
    ? " WHERE action LIKE ? ESCAPE '\\' OR target LIKE ? ESCAPE '\\' OR actor_username LIKE ? ESCAPE '\\'"
    : "";
  const args = options.query ? [pattern, pattern, pattern] : [];
  const total = scalar<number>(`SELECT COUNT(*) FROM admin_audit_log${where}`, ...args) ?? 0;
  const items = all<AuditEntry>(
    `SELECT id, actor_username, action, target, detail, ip, created_at FROM admin_audit_log${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
    ...args,
    options.limit,
    options.offset,
  );
  return { items, total };
}
