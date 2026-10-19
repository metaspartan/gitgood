export function describeUserAgent(ua: string | null): { label: string; mobile: boolean } {
  if (!ua) return { label: "Unknown device", mobile: false };
  const browser =
    /Edg\//.test(ua) ? "Edge"
    : /OPR\/|Opera/.test(ua) ? "Opera"
    : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\/|CriOS\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) && /Version\//.test(ua) ? "Safari"
    : /^git\//i.test(ua) ? "Git"
    : /curl\//i.test(ua) ? "curl"
    : null;
  const os =
    /iPhone|iPad|iPod/.test(ua) ? "iOS"
    : /Android/.test(ua) ? "Android"
    : /Windows/.test(ua) ? "Windows"
    : /Mac OS X|Macintosh/.test(ua) ? "macOS"
    : /CrOS/.test(ua) ? "ChromeOS"
    : /Linux/.test(ua) ? "Linux"
    : null;
  const mobile = /Mobile|iPhone|Android/.test(ua);
  if (browser && os) return { label: `${browser} on ${os}`, mobile };
  if (browser || os) return { label: (browser ?? os)!, mobile };
  return { label: ua.length > 60 ? `${ua.slice(0, 57)}\u2026` : ua, mobile };
}
