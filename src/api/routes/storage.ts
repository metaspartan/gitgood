import { requireAdmin } from "../../auth/service.ts";
import { forbidden } from "../../lib/errors.ts";
import { json } from "../../lib/http.ts";
import { storageOverview } from "../../lib/storage-overview.ts";
import type { RouteContext, Router } from "../router.ts";

function authorize(ctx: RouteContext): void {
  if (ctx.request.headers.has("authorization")) throw forbidden("Use an administrator browser session");
  const principal = requireAdmin(ctx.auth);
  if (principal.via !== "session") throw forbidden("Use an administrator browser session");
}

export function registerStorageRoutes(router: Router): void {
  router.get("/api/admin/storage", (ctx) => {
    authorize(ctx);
    return json(storageOverview());
  });
}
