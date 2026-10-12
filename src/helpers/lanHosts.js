// Private-address checks for plain-HTTP endpoints (main process, CommonJS).
//
// Self-hosted servers may use plain HTTP only on a private network. By name,
// that is a private IP literal, localhost, `.local` or `.ts.net`. A LAN server
// is often reached by an ordinary DNS name instead (`gpu.lan.example.com` →
// 10.0.0.82), which the name test alone rejects. `verifyLanHosts` resolves such
// names and trusts one only when every address it resolves to is private; the
// renderer and main both feed the result to `setVerifiedLanHosts` in
// src/utils/urlUtils.ts, so the synchronous isSecureHttpEndpoint check accepts it.
// A name that resolves to any public address, or doesn't resolve, stays rejected.

const dns = require("node:dns").promises;

const VERIFIED_TTL_MS = 5 * 60 * 1000;

// Mirror of isPrivateHost/parseIPv4Literal in src/utils/urlUtils.ts. The main
// process cannot import that Vite/TS module from CommonJS; keep them in sync.
function parseIPv4Literal(hostname) {
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;

  const octets = [];
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }

  return octets;
}

function isPrivateHost(hostname) {
  const h = String(hostname || "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "");

  if (h === "localhost" || h === "0.0.0.0") return true;
  if (h === "::1") return true;

  const ipv4 = parseIPv4Literal(h);
  if (ipv4) {
    const [a, b] = ipv4;
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
  }

  const isIPv6 = h.includes(":");
  if (isIPv6 && (/^fe[89ab]/.test(h) || h.startsWith("fc") || h.startsWith("fd"))) return true;
  if (h.endsWith(".local")) return true;
  if (h.endsWith(".ts.net")) return true;

  return false;
}

// IPv4-mapped IPv6 (::ffff:10.0.0.1) is judged by its IPv4 part.
function isPrivateAddress(address) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return isPrivateHost(mapped ? mapped[1] : address);
}

function hostnameOf(url) {
  const raw = typeof url === "string" ? url.trim() : "";
  if (!raw) return null;
  try {
    return new URL(raw.includes("://") ? raw : `http://${raw}`).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** A DNS name (not a literal, not already private by name) that may resolve to a LAN. */
function needsLookup(hostname) {
  if (!hostname || isPrivateHost(hostname)) return false;
  if (hostname.includes(":") || parseIPv4Literal(hostname)) return false;
  return hostname.includes(".");
}

function createLanHostVerifier({ lookup = dns.lookup, now = Date.now } = {}) {
  const verified = new Map(); // hostname -> verifiedAt

  async function isLanHostname(hostname) {
    if (!needsLookup(hostname)) return false;
    try {
      const addresses = await lookup(hostname, { all: true, verbatim: true });
      const ok =
        Array.isArray(addresses) &&
        addresses.length > 0 &&
        addresses.every((entry) => isPrivateAddress(entry.address));
      if (ok) verified.set(hostname, now());
      else verified.delete(hostname);
      return ok;
    } catch {
      verified.delete(hostname);
      return false;
    }
  }

  /** Resolve each URL's hostname; returns every hostname currently verified. */
  async function verifyLanHosts(urls = []) {
    const hostnames = [...new Set((urls || []).map(hostnameOf).filter(needsLookup))];
    await Promise.all(hostnames.map(isLanHostname));
    return currentVerifiedHosts();
  }

  function currentVerifiedHosts() {
    const cutoff = now() - VERIFIED_TTL_MS;
    for (const [hostname, at] of verified) {
      if (at < cutoff) verified.delete(hostname);
    }
    return [...verified.keys()];
  }

  return { isLanHostname, verifyLanHosts, currentVerifiedHosts };
}

const defaultVerifier = createLanHostVerifier();

module.exports = {
  isPrivateHost,
  hostnameOf,
  createLanHostVerifier,
  isLanHostname: defaultVerifier.isLanHostname,
  verifyLanHosts: defaultVerifier.verifyLanHosts,
  currentVerifiedHosts: defaultVerifier.currentVerifiedHosts,
  VERIFIED_TTL_MS,
};
