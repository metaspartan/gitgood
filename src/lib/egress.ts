import { lookup } from "node:dns/promises";

export type EgressVerdict = { ok: true } | { ok: false; reason: string };

export function isInternalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return true;
  }
  if (host.includes(":") || /^\d+(\.\d+){3}$/.test(host)) return isInternalIp(host);
  return false;
}

export function expandIpv6(ip: string): number[] | null {
  let text = ip.toLowerCase();
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);
  let tail: number[] = [];
  const lastColon = text.lastIndexOf(":");
  if (text.slice(lastColon + 1).includes(".")) {
    const quad = text.slice(lastColon + 1).split(".").map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
    if (quad.length !== 4 || quad.some((part) => !Number.isFinite(part) || part > 255)) return null;
    tail = [(quad[0]! << 8) | quad[1]!, (quad[2]! << 8) | quad[3]!];
    text = `${text.slice(0, lastColon + 1)}0:0`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const groups = part.split(":");
    const out: number[] = [];
    for (const group of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      out.push(Number.parseInt(group, 16));
    }
    return out;
  };
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  if (!head || !rest) return null;
  let groups: number[];
  if (halves.length === 2) {
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return null;
    groups = [...head, ...new Array<number>(missing).fill(0), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  if (tail.length === 2) groups.splice(6, 2, tail[0]!, tail[1]!);
  return groups;
}

export function isInternalIp(ip: string): boolean {
  if (ip.includes(":")) {
    const g = expandIpv6(ip);
    if (!g) return true;
    const embeddedV4 = () => `${g[6]! >> 8}.${g[6]! & 0xff}.${g[7]! >> 8}.${g[7]! & 0xff}`;
    const zeroPrefix = (n: number) => g.slice(0, n).every((v) => v === 0);
    if (g.every((v) => v === 0)) return true;
    if (zeroPrefix(7) && g[7] === 1) return true;
    if ((g[0]! & 0xffc0) === 0xfe80) return true;
    if ((g[0]! & 0xfe00) === 0xfc00) return true;
    if ((g[0]! & 0xff00) === 0xff00) return true;
    if (zeroPrefix(5) && g[5] === 0xffff) return isInternalIp(embeddedV4());
    if (zeroPrefix(6)) return isInternalIp(embeddedV4());
    if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((v) => v === 0)) return isInternalIp(embeddedV4());
    return false;
  }
  const parts = ip.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return true;
  const [a = 0, b = 0] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

export async function checkEgress(rawUrl: string, allowPrivate: boolean): Promise<EgressVerdict> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "scheme_not_allowed" };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "credentials_in_url" };
  }
  if (allowPrivate) return { ok: true };

  const hostname = url.hostname.replace(/^\[(.*)\]$/, "$1");
  if (isInternalHostname(hostname)) return { ok: false, reason: "internal_address" };

  try {
    const addresses = await lookup(hostname, { all: true });
    if (addresses.length === 0) return { ok: false, reason: "dns_failure" };
    for (const entry of addresses) {
      if (isInternalIp(entry.address)) return { ok: false, reason: "internal_address" };
    }
  } catch {
    return { ok: false, reason: "dns_failure" };
  }
  return { ok: true };
}
