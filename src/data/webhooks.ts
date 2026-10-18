import { checkEgress } from "../lib/egress.ts";
import { config } from "../config.ts";
import { all, changes, now, one, run } from "../db/index.ts";
import { notFound } from "../lib/errors.ts";
import { hmacSha256Hex } from "../lib/ids.ts";
import { increment, observe } from "../lib/metrics.ts";
import { log } from "../lib/logger.ts";

export interface WebhookRow {
  id: number;
  repo_id: number;
  url: string;
  secret: string;
  events: string;
  active: number;
  created_at: number;
}

export interface DeliveryRow {
  id: number;
  webhook_id: number;
  event: string;
  status_code: number | null;
  error: string | null;
  attempts: number;
  duration_ms: number;
  created_at: number;
}

export interface DeliveryStats {
  delivery_count: number;
  last_status: number | null;
  last_error: string | null;
  last_at: number | null;
}

export type WebhookWithStats = WebhookRow & DeliveryStats;

export const WEBHOOK_EVENTS = ["push", "issues", "pull_request"] as const;

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1_000;
const REQUEST_TIMEOUT_MS = 10_000;

export function listWebhooks(repoId: number): WebhookRow[] {
  return all<WebhookRow>("SELECT * FROM webhooks WHERE repo_id = ? ORDER BY id DESC", repoId);
}

export function findWebhook(repoId: number, id: number): WebhookRow | null {
  return one<WebhookRow>("SELECT * FROM webhooks WHERE id = ? AND repo_id = ?", id, repoId);
}

export function listWebhooksWithStats(repoId: number): WebhookWithStats[] {
  const hooks = listWebhooks(repoId);
  if (hooks.length === 0) return [];

  const counts = all<{ webhook_id: number; c: number }>(
    `SELECT webhook_id, COUNT(*) AS c FROM webhook_deliveries
     WHERE webhook_id IN (SELECT id FROM webhooks WHERE repo_id = ?)
     GROUP BY webhook_id`,
    repoId,
  );
  const countsById = new Map(counts.map((row) => [row.webhook_id, row.c]));

  const latest = all<{ webhook_id: number; status_code: number | null; error: string | null; created_at: number }>(
    `SELECT d.webhook_id, d.status_code, d.error, d.created_at
     FROM webhook_deliveries d
     JOIN (
       SELECT webhook_id, MAX(id) AS max_id FROM webhook_deliveries GROUP BY webhook_id
     ) latest ON latest.max_id = d.id
     WHERE d.webhook_id IN (SELECT id FROM webhooks WHERE repo_id = ?)`,
    repoId,
  );
  const latestById = new Map(latest.map((row) => [row.webhook_id, row]));

  return hooks.map((hook) => {
    const last = latestById.get(hook.id);
    return {
      ...hook,
      delivery_count: countsById.get(hook.id) ?? 0,
      last_status: last?.status_code ?? null,
      last_error: last?.error ?? null,
      last_at: last?.created_at ?? null,
    };
  });
}

export function listDeliveries(webhookId: number, limit = 25): DeliveryRow[] {
  return all<DeliveryRow>(
    "SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY id DESC LIMIT ?",
    webhookId,
    limit,
  );
}

export function createWebhook(
  repoId: number,
  url: string,
  secret: string,
  events: readonly string[],
): WebhookRow {
  const id = run(
    "INSERT INTO webhooks (repo_id, url, secret, events, active, created_at) VALUES (?, ?, ?, ?, 1, ?)",
    repoId,
    url,
    secret,
    events.join(","),
    now(),
  );
  const created = one<WebhookRow>("SELECT * FROM webhooks WHERE id = ?", id);
  if (!created) throw notFound("Webhook not found after creation");
  return created;
}

export function deleteWebhook(repoId: number, id: number): boolean {
  return changes("DELETE FROM webhooks WHERE id = ? AND repo_id = ?", id, repoId) > 0;
}

function recordDelivery(
  webhookId: number,
  event: string,
  statusCode: number | null,
  error: string | null,
  attempts: number,
  durationMs: number,
): void {
  run(
    `INSERT INTO webhook_deliveries (webhook_id, event, status_code, error, attempts, duration_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    webhookId,
    event,
    statusCode,
    error,
    attempts,
    durationMs,
    now(),
  );
}

export interface WebhookEvent {
  event: string;
  payload: Record<string, unknown>;
}

interface AttemptResult {
  ok: boolean;
  status: number | null;
  error: string | null;
  transient: boolean;
}

async function attemptDelivery(hook: WebhookRow, event: string, body: string): Promise<AttemptResult> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "GitGood-Webhooks/1.0",
    "x-gitgood-event": event,
    "x-gitgood-delivery": crypto.randomUUID(),
  };
  if (hook.secret) {
    const signature = hmacSha256Hex(hook.secret, body);
    headers["x-hub-signature-256"] = `sha256=${signature}`;
    headers["x-gitgood-signature-256"] = `sha256=${signature}`;
  }

  const egress = await checkEgress(hook.url, config.webhookAllowPrivate);
  if (!egress.ok) {
    return { ok: false, status: null, error: `blocked_${egress.reason}`, transient: false };
  }

  try {
    const response = await fetch(hook.url, {
      method: "POST",
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return { ok: false, status: response.status, error: "redirect_not_followed", transient: false };
    }
    if (response.ok) return { ok: true, status: response.status, error: null, transient: false };
    const transient = response.status === 429 || response.status >= 500;
    return { ok: false, status: response.status, error: null, transient };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    const code = name === "TimeoutError" || name === "AbortError" ? "timeout" : "network_error";
    return { ok: false, status: null, error: code, transient: true };
  }
}

async function deliverWithRetry(hook: WebhookRow, event: string, body: string): Promise<void> {
  const started = performance.now();
  let last: AttemptResult = { ok: false, status: null, error: "not attempted", transient: true };
  let attempt = 0;

  for (attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    last = await attemptDelivery(hook, event, body);
    if (last.ok || !last.transient || attempt === MAX_ATTEMPTS) break;
    const delay = BASE_BACKOFF_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
    await Bun.sleep(delay);
  }

  const durationMs = Math.round(performance.now() - started);
  recordDelivery(hook.id, event, last.status, last.error, attempt, durationMs);
  increment(last.ok ? "webhook_deliveries_succeeded_total" : "webhook_deliveries_failed_total");
  observe("webhook_delivery_ms", durationMs);

  if (!last.ok) {
    log.warn("webhook delivery failed", {
      webhookId: hook.id,
      event,
      attempts: attempt,
      status: last.status,
      reason: last.error,
    });
  }
}

export function dispatchWebhooks(repoId: number, event: WebhookEvent): void {
  const hooks = listWebhooks(repoId).filter(
    (hook) => hook.active === 1 && (hook.events.split(",").includes(event.event) || hook.events.split(",").includes("*")),
  );
  if (hooks.length === 0) return;

  const body = JSON.stringify({ ...event.payload, event: event.event });
  for (const hook of hooks) {
    increment("webhook_deliveries_total");
    void deliverWithRetry(hook, event.event, body).catch((error: unknown) => {
      log.error("webhook delivery crashed", {
        webhookId: hook.id,
        reason: error instanceof Error ? error.message : String(error),
      });
    });
  }
}
