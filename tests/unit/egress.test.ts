import { describe, expect, test } from "bun:test";
import { checkEgress, expandIpv6, isInternalHostname, isInternalIp } from "../../src/lib/egress.ts";

describe("isInternalIp", () => {
  test("loopback, private, link-local and reserved ranges are internal", () => {
    for (const ip of [
      "127.0.0.1",
      "127.8.8.8",
      "10.0.0.5",
      "10.255.1.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "0.0.0.0",
      "100.64.0.1",
      "224.0.0.1",
      "::1",
      "::",
      "fe80::1",
      "fc00::1",
      "fd12:3456::1",
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.9",
    ]) {
      expect(isInternalIp(ip)).toBe(true);
    }
  });

  test("public addresses are not internal", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "172.15.255.255", "192.0.2.1", "2606:4700::1111"]) {
      expect(isInternalIp(ip)).toBe(false);
    }
  });

  test("malformed input fails closed", () => {
    expect(isInternalIp("not-an-ip")).toBe(true);
    expect(isInternalIp("999.1.1.1")).toBe(true);
  });
});

describe("isInternalHostname", () => {
  test("localhost and lookalike suffixes are internal", () => {
    for (const host of ["localhost", "api.localhost", "printer.local", "db.internal", "LOCALHOST"]) {
      expect(isInternalHostname(host)).toBe(true);
    }
  });

  test("public hostnames are not internal", () => {
    expect(isInternalHostname("example.com")).toBe(false);
    expect(isInternalHostname("notlocalhost")).toBe(false);
  });

  test("IPv4-mapped IPv6 is unwrapped", () => {
    expect(isInternalHostname("::ffff:192.168.0.1")).toBe(true);
    expect(isInternalHostname("::ffff:8.8.8.8")).toBe(false);
  });
});

describe("checkEgress", () => {
  test("rejects non-http schemes, malformed URLs and embedded credentials", async () => {
    for (const [url, reason] of [
      ["ftp://example.com/x", "scheme_not_allowed"],
      ["file:///etc/passwd", "scheme_not_allowed"],
      ["not a url", "invalid_url"],
      ["https://user:pass@example.com/hook", "credentials_in_url"],
    ] as Array<[string, string]>) {
      const verdict = await checkEgress(url, false);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe(reason);
    }
  });

  test("literal internal targets are refused before any DNS", async () => {
    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "http://127.0.0.1:3000/api/health",
      "http://10.1.2.3/hook",
      "http://[::1]/hook",
      "http://localhost:8080/hook",
    ]) {
      const verdict = await checkEgress(url, false);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe("internal_address");
    }
  });

  test("allowPrivate short-circuits both layers", async () => {
    const verdict = await checkEgress("http://169.254.169.254/latest/meta-data/", true);
    expect(verdict.ok).toBe(true);
  });

  test("a public IP literal passes without touching DNS", async () => {
    const verdict = await checkEgress("http://192.0.2.1/hook", false);
    expect(verdict.ok).toBe(true);
  });
});

describe("IPv6 literals in URLs", () => {
  test("every internal spelling is refused as internal_address", async () => {
    for (const url of [
      "http://[::1]/hook",
      "http://[0:0:0:0:0:0:0:1]/hook",
      "http://[::]/hook",
      "http://[::ffff:127.0.0.1]/hook",
      "http://[::ffff:7f00:1]/hook",
      "http://[::ffff:10.0.0.1]/hook",
      "http://[::ffff:169.254.169.254]/hook",
      "http://[::ffff:192.168.1.10]/hook",
      "http://[::127.0.0.1]/hook",
      "http://[64:ff9b::a9fe:a9fe]/hook",
      "http://[fe80::1]/hook",
      "http://[febf::1]/hook",
      "http://[fd12:3456::1]/hook",
      "http://[ff02::1]/hook",
    ]) {
      const verdict = await checkEgress(url, false);
      expect(verdict, url).toEqual({ ok: false, reason: "internal_address" });
    }
  });

  test("public addresses, including mapped public IPv4, are allowed", async () => {
    for (const url of ["http://[2606:4700:4700::1111]/hook", "http://[::ffff:8.8.8.8]/hook", "http://[fec0::1]/hook"]) {
      expect(await checkEgress(url, false), url).toEqual({ ok: true });
    }
  });

  test("unparseable IPv6 fails closed", () => {
    for (const ip of ["1::2::3", "12345::1", "::ffff:1.2.3", "::ffff:1.2.3.999", "g::1", "1:2:3:4:5:6:7:8:9"]) {
      expect(isInternalIp(ip), ip).toBe(true);
    }
  });

  test("expansion handles compression and a dotted tail", () => {
    expect(expandIpv6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(expandIpv6("::ffff:1.2.3.4")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
    expect(expandIpv6("2001:db8::")).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 0]);
    expect(expandIpv6("fe80::1%eth0")).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
    expect(expandIpv6("1:2:3:4:5:6:7:8")).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
