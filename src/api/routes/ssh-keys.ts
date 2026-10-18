import { json, readJson } from "../../lib/http.ts";
import * as v from "../../lib/validate.ts";
import { requireUser } from "../../auth/service.ts";
import { addKey, listKeys, removeKey, type SshKeyRow } from "../../ssh/keys.ts";
import { sshKeyJson } from "../serialize.ts";
import { param } from "../helpers.ts";
import { toInt } from "../../lib/validate.ts";
import type { Router } from "../router.ts";

const addKeySchema = v.strictObject({
  title: v.optional(v.string({ max: 120 })),
  public_key: v.string({ min: 32, max: 16_384 }),
});

export function registerSshKeyRoutes(router: Router): void {
  router.get("/api/ssh-keys", (ctx) => {
    const principal = requireUser(ctx.auth);
    return json({ items: listKeys(principal.userId).map(sshKeyJson) });
  });

  router.post("/api/ssh-keys", async (ctx) => {
    const principal = requireUser(ctx.auth);
    const body = await readJson(ctx.request, addKeySchema);
    const key = addKey(principal.userId, {
      publicKey: body.public_key,
      ...(body.title === undefined ? {} : { title: body.title }),
    });
    return json(sshKeyJson(key), { status: 201 });
  });

  router.delete("/api/ssh-keys/:id", (ctx) => {
    const principal = requireUser(ctx.auth);
    const id = toInt(param(ctx, "id"), 0, 0, Number.MAX_SAFE_INTEGER);
    if (!removeKey(principal.userId, id)) {
      return json({ error: { code: "not_found", message: "No such key" } }, { status: 404 });
    }
    return json({ ok: true });
  });

  router.get("/api/ssh-keys/authorized-keys", (ctx) => {
    const principal = requireUser(ctx.auth);
    if (!principal.isAdmin) {
      return json(
        { error: { code: "forbidden", message: "Administrator access required" } },
        { status: 403 },
      );
    }
    const file = authorizedKeysForInstance();
    return new Response(file, {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": 'attachment; filename="authorized_keys"',
      },
    });
  });
}

import { authorizedKeysFile, listAllKeysWithOwners } from "../../ssh/keys.ts";
import { config } from "../../config.ts";

function authorizedKeysForInstance(): string {
  const keys: SshKeyRow[] = listAllKeysWithOwners().map((row) => ({
    id: row.id,
    user_id: row.user_id,
    title: row.title,
    fingerprint: row.fingerprint,
    public_key: row.public_key,
    created_at: row.created_at,
  }));
  return authorizedKeysFile(keys, config.sshCommand);
}
