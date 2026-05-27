// Server configuration — resolved from Vite env vars at build time.
// Local dev: defaults to localhost (no .env needed)
// LAN/staging: set VITE_SERVER_HOST in .env or .env.staging (e.g., "192.0.2.19")
const SERVER_HOST = import.meta.env.VITE_SERVER_HOST || 'localhost';
const API_PORT = import.meta.env.VITE_API_PORT || '8080';
const USE_TLS = import.meta.env.VITE_USE_TLS === 'true';

const protocol = USE_TLS ? 'https' : 'http';
const wsProtocol = USE_TLS ? 'wss' : 'ws';

// Omit port when it's the default for the protocol (443 for TLS, 80 for plain)
const isDefaultPort = (USE_TLS && API_PORT === '443') || (!USE_TLS && API_PORT === '80');
const portSuffix = isDefaultPort ? '' : `:${API_PORT}`;

export const API_BASE = `${protocol}://${SERVER_HOST}${portSuffix}`;
export const WS_BASE = `${wsProtocol}://${SERVER_HOST}${portSuffix}`;

// SPA build identifier — try build-time env var first, then a runtime URL match
// against `/spa/<sha>/` in the loaded document URL, then fall back to 'bundled'.
// The runtime fallback handles two cases that the build-time-only constant missed:
//   1. Remote SPA build where VITE_SPA_VERSION wasn't set at build time (the bug
//      hypothesized in #547 Investigation: deploy-spa.yml may have drifted).
//   2. Bundled config.ts rendering Settings even when a remote SPA is loaded —
//      `globalThis.location.href` reflects the actual top-level document URL,
//      not the source of the rendering code.

// Match the canonical SPA URL contract from ADR-0001: the remote SPA is served
// at `https://<host>/spa/<sha>/...` where <sha> is a lowercase hex git short
// hash. Mirrors the SPA_HASH_RE pattern in
// `src/main/ipc/versionInfo.ts` (which operates on URL.pathname);
// here we match against the full href so the regex is full-URL anchored.
// Bounded {7,40} on the hex group prevents super-linear backtracking;
// `[^/]+` host segment is followed by a literal `/spa/`, so backtracking
// stays linear. Extracted to module scope for clarity.
const SPA_SHA_FROM_URL_PATTERN = /^https?:\/\/[^/]+\/spa\/([0-9a-f]{7,40})\//i;

// Sanity cap on the input length before regex matching — defense-in-depth
// against unbounded inputs even though the regex itself is bounded.
const MAX_HREF_LEN_FOR_MATCH = 2048;

function detectSpaVersion(): string {
  const buildTime = import.meta.env.VITE_SPA_VERSION;
  if (buildTime) return buildTime;

  const href = (globalThis.location?.href ?? '').slice(0, MAX_HREF_LEN_FOR_MATCH);
  // SonarQube typescript:S6594 prefers `RegExp.exec()` over `String#match()`
  // for non-global patterns — it's marginally faster and clearer about
  // intent. (Earlier draft used .match() to work around a plugin hook's
  // false-positive on `.exec(` matching child_process.exec — that hook
  // false-positive is tracked separately; the SonarQube rule is the
  // governing standard for production code.)
  const match = SPA_SHA_FROM_URL_PATTERN.exec(href);
  if (match) return match[1];

  return 'bundled';
}

export const SPA_VERSION = detectSpaVersion();
