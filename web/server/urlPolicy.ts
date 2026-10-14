/**
 * Which URLs the browser may open. Public http(s) sites only: no other schemes, and nothing on
 * this machine or the local network, so a page can't steer Claude into the control UI, a router
 * admin page or a cloud metadata endpoint.
 */

const SCHEME_PREFIX = /^[a-z][a-z0-9+.-]*:/i;

/** Adds https:// when Claude leaves the scheme off ("example.com/path"). */
export function withScheme(url: string): string {
  const trimmed = url.trim();
  return SCHEME_PREFIX.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export function refusal(url: string): string | null {
  if (url.trim().toLowerCase() === "about:blank") return null;
  // A browser reads "\" as "/" in a web URL.
  const parsed = URL.parse(withScheme(url).replaceAll("\\", "/"));
  if (!parsed) return "That is not a valid URL.";
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "Navigation refused. Only http and https URLs are allowed.";
  }
  if (isPrivateHost(parsed.hostname)) {
    return "Navigation refused. Local and private network addresses are blocked.";
  }
  return null;
}

export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return true;
  }
  if (!host.includes(".") && !host.includes(":")) return true; // single-label names resolve on the LAN

  const v4 = parseIPv4(host);
  if (v4) {
    const [a, b] = v4;
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
      (a === 169 && b === 254) ||           // link-local, cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224                               // multicast, reserved
    );
  }
  if (host.includes(":")) {
    if (host === "::" || host === "::1") return true;
    if (/^f[cd]/.test(host) || /^fe[89ab]/.test(host)) return true; // unique-local, link-local
    const mapped = host.match(/^::ffff:(.+)$/);
    if (mapped) return mapped[1].includes(".") ? isPrivateHost(mapped[1]) : true;
  }
  return false;
}

/** Dotted IPv4 as the URL parser normalizes it (it already turns "0x7f.1" into "127.0.0.1"). */
function parseIPv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return null;
  const nums = parts.map(Number);
  return nums.every((n) => n <= 255) ? nums : null;
}
