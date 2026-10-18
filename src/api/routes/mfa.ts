import { randomBytes } from "node:crypto";
import * as v from "../../lib/validate.ts";
import { badRequest, forbidden, unauthorized } from "../../lib/errors.ts";
import { json, publicOrigin, readJson } from "../../lib/http.ts";
import { b64urlEncode, detectClonedAuthenticator, verifyAssertion } from "../../auth/webauthn.ts";
import { generateRecoveryCodes, generateTotpSecret, isWellFormedCode, verifyTotp } from "../../auth/totp.ts";
import { findUserByUsername } from "../../auth/service.ts";
import {
  clearRecoveryCodes,
  confirmTotp,
  countPasskeys,
  countRecoveryCodes,
  currentTotpStep,
  deletePasskey,
  disableTotp,
  findPasskeyByCredentialId,
  getTotpState,
  insertPasskey,
  listPasskeys,
  replaceRecoveryCodes,
  setPendingTotpSecret,
  storeChallenge,
  takeChallenge,
  touchPasskey,
} from "../../auth/account-store.ts";
import type { RouteContext, Router } from "../router.ts";

interface AuthenticatedUser {
  id: number;
  username: string;
}

function requireUser(ctx: RouteContext): AuthenticatedUser {
  if (ctx.auth.kind !== "user") throw unauthorized();
  return { id: ctx.auth.userId, username: ctx.auth.username };
}

function accountFor(username: string): AuthenticatedUser | null {
  const row = findUserByUsername(username);
  return row ? { id: row.id, username: row.username } : null;
}

export function registerMfaRoutes(router: Router): void {

  router.post("/api/auth/mfa/totp/begin", (ctx) => {
    const user = requireUser(ctx);
    const enrollment = generateTotpSecret(user.username);
    setPendingTotpSecret(user.id, enrollment.secret);
    return json({
      secret: enrollment.displaySecret,
      uri: enrollment.uri,
      confirmed: false,
    });
  });

  router.post("/api/auth/mfa/totp/confirm", async (ctx) => {
    const user = requireUser(ctx);
    const body = await readJson(ctx.request, v.strictObject({ code: v.string({ min: 6, max: 8 }) }));
    if (!isWellFormedCode(body.code)) throw badRequest("That is not a six-digit code");
    const state = getTotpState(user.id);
    if (!state.secret) throw badRequest("Start enrolment first");
    if (!verifyTotp(state.secret, body.code)) throw badRequest("That code did not match; check the device clock");

    confirmTotp(user.id, currentTotpStep(Math.floor(Date.now() / 1000)));
    const codes = generateRecoveryCodes();
    replaceRecoveryCodes(user.id, codes.hashes);
    return json({ confirmed: true, recovery_codes: codes.plaintext });
  });

  router.post("/api/auth/mfa/totp/disable", async (ctx) => {
    const user = requireUser(ctx);
    const body = await readJson(ctx.request, v.strictObject({ code: v.string({ min: 6, max: 8 }) }));
    const state = getTotpState(user.id);
    if (!state.secret || state.confirmed_at === null) throw badRequest("Two-factor is not enabled");
    if (!verifyTotp(state.secret, body.code)) throw badRequest("That code did not match");
    disableTotp(user.id);
    clearRecoveryCodes(user.id);
    return json({ confirmed: false });
  });

  router.post("/api/auth/mfa/recovery-codes", async (ctx) => {
    const user = requireUser(ctx);
    const body = await readJson(ctx.request, v.strictObject({ code: v.string({ min: 6, max: 8 }) }));
    const state = getTotpState(user.id);
    if (!state.secret || state.confirmed_at === null) throw badRequest("Two-factor is not enabled");
    if (!verifyTotp(state.secret, body.code)) throw badRequest("That code did not match");
    const codes = generateRecoveryCodes();
    replaceRecoveryCodes(user.id, codes.hashes);
    return json({ recovery_codes: codes.plaintext });
  });

  router.get("/api/auth/mfa", (ctx) => {
    const user = requireUser(ctx);
    const state = getTotpState(user.id);
    return json({
      totp_enabled: state.secret !== null && state.confirmed_at !== null,
      totp_pending: state.secret !== null && state.confirmed_at === null,
      recovery_codes_remaining: countRecoveryCodes(user.id),
      passkeys: listPasskeys(user.id).map((p) => ({
        id: p.id,
        label: p.label,
        created_at: p.created_at,
        last_used_at: p.last_used_at,
      })),
    });
  });

  router.post("/api/auth/passkeys/challenge", async (ctx) => {
    const user = requireUser(ctx);
    const body = await readJson(ctx.request, v.strictObject({ label: v.optional(v.string({ max: 60 })) }));
    const challenge = b64urlEncode(randomBytes(32));
    storeChallenge(user.id, challenge, "register");
    const origin = publicOrigin(ctx.request, ctx.url);
    return json({
      challenge,
      rp: { name: "GitGood", id: new URL(origin).hostname },
      user: {
        id: Buffer.from(String(user.id)).toString("base64url"),
        name: user.username,
        displayName: user.username,
      },
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -8 },
      ],
      timeout: 60_000,
      attestation: "none",
      authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
      label: body.label ?? "",
    });
  });

  router.post("/api/auth/passkeys", async (ctx) => {
    const user = requireUser(ctx);
    const body = await readJson(
      ctx.request,
      v.strictObject({
        credential_id: v.string({ min: 8, max: 2048 }),
        public_key: v.string({ min: 16, max: 8192 }),
        client_data_json: v.string({ min: 16, max: 8192 }),
        label: v.optional(v.string({ max: 60 })),
        sign_count: v.optional(v.number({ int: true, min: 0 })),
      }),
    );

    const expected = takeChallenge(user.id, "register");
    if (!expected) throw badRequest("No registration challenge in progress; start again");

    let clientData: { type?: string; challenge?: string; origin?: string };
    try {
      clientData = JSON.parse(Buffer.from(body.client_data_json, "base64url").toString("utf8")) as typeof clientData;
    } catch {
      throw badRequest("client_data_json is not valid JSON");
    }
    if (clientData.type !== "webauthn.create") throw badRequest("Unexpected ceremony type");
    if (clientData.challenge !== expected) throw badRequest("Challenge mismatch");
    if (clientData.origin !== publicOrigin(ctx.request, ctx.url)) throw badRequest("Origin mismatch");

    try {
      JSON.parse(body.public_key);
    } catch {
      throw badRequest("public_key is not valid JSON");
    }

    const index = listPasskeys(user.id).length;
    insertPasskey({
      userId: user.id,
      credentialId: body.credential_id,
      publicKey: body.public_key,
      signCount: body.sign_count ?? 0,
      label: body.label && body.label.trim().length > 0 ? body.label.trim().slice(0, 60) : `Passkey ${index + 1}`,
    });
    return json({ ok: true, count: countPasskeys(user.id) });
  });

  router.post("/api/auth/passkeys/challenge-login", async (ctx) => {
    const body = await readJson(ctx.request, v.strictObject({ username: v.string({ min: 1, max: 254 }) }));
    const account = accountFor(body.username);
    const challenge = b64urlEncode(randomBytes(32));
    if (account) storeChallenge(account.id, challenge, "assert");
    const origin = publicOrigin(ctx.request, ctx.url);
    return json({
      challenge,
      rpId: new URL(origin).hostname,
      allowCredentials: account
        ? listPasskeys(account.id).map((p) => ({ type: "public-key", id: p.credential_id }))
        : [],
      timeout: 60_000,
      userVerification: "preferred",
    });
  });

  router.post("/api/auth/passkeys/assert", async (ctx) => {
    const body = await readJson(
      ctx.request,
      v.strictObject({
        username: v.string({ min: 1, max: 254 }),
        credential_id: v.string({ min: 8, max: 2048 }),
        client_data_json: v.string({ min: 16, max: 8192 }),
        authenticator_data: v.string({ min: 16, max: 8192 }),
        signature: v.string({ min: 16, max: 8192 }),
      }),
    );

    const account = accountFor(body.username);
    if (!account) throw unauthorized("Passkey sign-in failed");
    const expected = takeChallenge(account.id, "assert");
    if (!expected) throw unauthorized("Passkey sign-in failed");

    const passkey = findPasskeyByCredentialId(body.credential_id);
    if (!passkey || passkey.user_id !== account.id) throw unauthorized("Passkey sign-in failed");

    const result = verifyAssertion(passkey.public_key, {
      clientDataJSON: body.client_data_json,
      authenticatorData: body.authenticator_data,
      signature: body.signature,
      expectedChallenge: expected,
      expectedOrigin: publicOrigin(ctx.request, ctx.url),
    });
    if (!result.ok) throw unauthorized("Passkey sign-in failed");

    if (detectClonedAuthenticator(passkey.sign_count, result.signCount ?? 0)) {
      throw forbidden("That passkey looks cloned; sign in another way and remove it");
    }
    touchPasskey(passkey.id, result.signCount ?? 0);

    return json({ user: account });
  });

  router.delete("/api/auth/passkeys/:id", (ctx) => {
    const user = requireUser(ctx);
    const id = Number.parseInt(ctx.params.id ?? "", 10);
    if (!Number.isFinite(id)) throw badRequest("Invalid passkey id");
    const state = getTotpState(user.id);
    const totpEnabled = state.secret !== null && state.confirmed_at !== null;
    if (!totpEnabled && countPasskeys(user.id) <= 1) {
      throw badRequest("That is your only second factor; enable an authenticator app first");
    }
    if (!deletePasskey(user.id, id)) throw badRequest("No such passkey");
    return json({ ok: true, count: countPasskeys(user.id) });
  });
}
