import { json, jsonFor, readJson, weakEtag } from "../../lib/http.ts";
import * as v from "../../lib/validate.ts";
import { requireUser } from "../../auth/service.ts";
import {
  clearAll,
  countNotifications,
  countUnread,
  deleteNotification,
  listNotifications,
  markAllRead,
  markRead,
  markUnread,
  unreadByRepo,
} from "../../data/notifications.ts";
import { notificationJson } from "../serialize.ts";
import { param, optionalQuery } from "../helpers.ts";
import { toInt } from "../../lib/validate.ts";
import type { Router } from "../router.ts";

const markReadSchema = v.strictObject({ read: v.optional(v.boolean()) });

export function registerNotificationRoutes(router: Router): void {
  router.get("/api/notifications/unread-count", (ctx) => {
    const principal = requireUser(ctx.auth);
    return json({ unread: countUnread(principal.userId) });
  });

  router.get("/api/notifications", (ctx) => {
    const principal = requireUser(ctx.auth);
    const unreadOnly = optionalQuery(ctx, "unread") === "true";
    const page = {
      limit: toInt(ctx.url.searchParams.get("per_page"), 30, 1, 100),
      offset: 0,
    };
    const pageNumber = toInt(ctx.url.searchParams.get("page"), 1, 1, 1000);
    page.offset = (pageNumber - 1) * page.limit;

    const rows = listNotifications(principal.userId, {
      unreadOnly,
      limit: page.limit,
      offset: page.offset,
    });
    const items = rows.map(notificationJson);
    return jsonFor(
      ctx.request,
      {
        items,
        unread: countUnread(principal.userId),
        total: countNotifications(principal.userId, unreadOnly),
        page: pageNumber,
        per_page: page.limit,
      },
      { etag: weakEtag(JSON.stringify(items)) },
    );
  });

  router.get("/api/notifications/by-repo", (ctx) => {
    const principal = requireUser(ctx.auth);
    return json({ items: unreadByRepo(principal.userId) });
  });

  router.post("/api/notifications/read-all", (ctx) => {
    const principal = requireUser(ctx.auth);
    const marked = markAllRead(principal.userId);
    return json({ ok: true, marked });
  });

  router.delete("/api/notifications", (ctx) => {
    const principal = requireUser(ctx.auth);
    const removed = clearAll(principal.userId);
    return json({ ok: true, removed });
  });

  router.patch("/api/notifications/:id", async (ctx) => {
    const principal = requireUser(ctx.auth);
    const id = toInt(param(ctx, "id"), 0, 0, Number.MAX_SAFE_INTEGER);
    const body = await readJson(ctx.request, markReadSchema);
    const read = body.read ?? true;
    const changed = read ? markRead(principal.userId, id) : markUnread(principal.userId, id);
    if (!changed) {
      return json({ error: { code: "not_found", message: "No such notification" } }, { status: 404 });
    }
    return json({ ok: true, read });
  });

  router.delete("/api/notifications/:id", (ctx) => {
    const principal = requireUser(ctx.auth);
    const id = toInt(param(ctx, "id"), 0, 0, Number.MAX_SAFE_INTEGER);
    if (!deleteNotification(principal.userId, id)) {
      return json({ error: { code: "not_found", message: "No such notification" } }, { status: 404 });
    }
    return json({ ok: true });
  });
}
