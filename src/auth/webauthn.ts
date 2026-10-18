import { createHash, createPublicKey, createVerify, timingSafeEqual, type JsonWebKeyInput } from "node:crypto";

export interface AssertionInput {
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
  expectedChallenge: string;
  expectedOrigin: string;
}

export interface AssertionResult {
  ok: boolean;
  reason?: string;
  signCount?: number;
}

export function b64urlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function b64urlDecode(input: string): Uint8Array {
  return new Uint8Array(Buffer.from(input, "base64url"));
}

export function verifyAssertion(
  storedPublicKeyJwk: string,
  input: AssertionInput,
): AssertionResult {
  let clientData: { type?: string; challenge?: string; origin?: string };
  try {
    clientData = JSON.parse(Buffer.from(b64urlDecode(input.clientDataJSON)).toString("utf8")) as typeof clientData;
  } catch {
    return { ok: false, reason: "clientDataJSON is not JSON" };
  }

  if (clientData.type !== "webauthn.get") {
    return { ok: false, reason: `unexpected ceremony type: ${String(clientData.type)}` };
  }
  if (clientData.challenge !== input.expectedChallenge) {
    return { ok: false, reason: "challenge mismatch" };
  }
  if (clientData.origin !== input.expectedOrigin) {
    return { ok: false, reason: `origin mismatch: ${String(clientData.origin)}` };
  }

  const authData = b64urlDecode(input.authenticatorData);
  if (authData.length < 37) return { ok: false, reason: "authenticatorData too short" };

  const rpIdHash = authData.subarray(0, 32);
  const expectedRpIdHash = createHash("sha256").update(new URL(input.expectedOrigin).hostname).digest();
  if (!timingSafeEqual(Buffer.from(rpIdHash), expectedRpIdHash)) {
    return { ok: false, reason: "rpIdHash does not match this host" };
  }

  const flags = authData[32] as number;
  if ((flags & 0x01) === 0) return { ok: false, reason: "user-present flag not set" };

  const signCount =
    ((authData[33] as number) << 24) |
    ((authData[34] as number) << 16) |
    ((authData[35] as number) << 8) |
    (authData[36] as number);

  const clientHash = createHash("sha256").update(Buffer.from(b64urlDecode(input.clientDataJSON))).digest();
  const signedData = Buffer.concat([Buffer.from(authData), clientHash]);

  let key: ReturnType<typeof createPublicKey>;
  try {
    const parsed = JSON.parse(storedPublicKeyJwk) as JsonWebKeyInput["key"];
    key = createPublicKey({ key: parsed, format: "jwk" });
  } catch (cause) {
    return { ok: false, reason: `stored public key is unusable: ${cause instanceof Error ? cause.message : String(cause)}` };
  }

  const algorithm = key.asymmetricKeyType === "ed25519" ? "Ed25519" : "sha256";
  const verifier = createVerify(algorithm);
  verifier.update(signedData);
  const signature = Buffer.from(b64urlDecode(input.signature));
  let valid = false;
  try {
    valid = verifier.verify(key, signature);
  } catch (cause) {
    return { ok: false, reason: `signature verification threw: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
  if (!valid) return { ok: false, reason: "signature does not verify" };

  return { ok: true, signCount };
}

export function detectClonedAuthenticator(stored: number, presented: number): boolean {
  if (presented === 0 || stored === 0) return false;
  return presented <= stored;
}

export function describeCredential(label: string | undefined, index: number): string {
  const trimmed = (label ?? "").trim();
  if (trimmed.length > 0 && trimmed.length <= 60) return trimmed;
  return `Passkey ${index + 1}`;
}
