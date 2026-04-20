/**
 * Sentry event scrubbers — fail-closed allowlist model.
 *
 * Default behavior: strip ALL custom data from events and breadcrumbs.
 * Only explicitly allowlisted fields survive to reach Sentry.
 *
 * Adding a new allowed field is a deliberate code change that goes through
 * PR review — this is the mechanical safety net for privacy compliance.
 *
 * See internal-reference for governance rules.
 * See internal-reference for spec.
 */

// ─── Allowlists (the source of truth for what reaches Sentry) ──────────────

/** Sentry context keys that are safe to transmit (OS/device metadata only). */
export const ALLOWED_CONTEXTS = new Set(['os', 'browser', 'electron', 'device', 'runtime', 'app']);

/** Sentry tag keys that are safe to transmit (build/env identifiers only). */
export const ALLOWED_TAG_KEYS = new Set([
  'environment',
  'release',
  'level',
  'transaction',
  'electron.process',
  'handled',
  'boundary',
]);

/**
 * Breadcrumb categories permitted to carry structured `data` payloads, plus
 * the exact set of data keys allowed per category. All other breadcrumb data
 * is stripped (fail-closed default preserved).
 *
 * Extending this map requires bumping TELEMETRY_POLICY_VERSION and adding
 * matching entries in sentry-allowlist-descriptions.ts (enforced by the
 * invariant test in sentry-allowlist-descriptions.test.ts).
 */
export const ALLOWED_BREADCRUMB_CATEGORY_DATA_KEYS: Record<string, Set<string>> = {
  // Cert-pinning outcomes (#658). Never carries cert contents, subject DN, or
  // serial — only the bounded enumeration below.
  'update.pin': new Set(['outcome', 'host', 'spkiLast8']),
};

/** Device context subfields that fingerprint hardware and must be dropped. */
export const DROPPED_DEVICE_SUBFIELDS = new Set([
  'model',
  'model_id',
  'cpu_description',
  'processor_frequency',
  'boot_time',
  'screen_resolution',
  'screen_density',
  'timezone',
  'locale',
]);

// ─── Sensitive pattern redaction ────────────────────────────────────────────

const SENSITIVE_PATTERNS: RegExp[] = [
  // JWT tokens — match all 3 segments (header.payload.signature) so the
  // signature isn't left behind as an orphan string. Must come before the
  // base64 pattern since JWT segments are valid base64.
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g,
  // Base64/base64url blobs (keys, tokens) — 64 char min to avoid false
  // positives on stack traces. Includes +, /, -, _ (base64 + base64url)
  // and optional = padding. Uses non-word-char boundaries instead of \b
  // because = and - are non-word chars that \b wouldn't anchor correctly.
  /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/=_-]{64,}(?![A-Za-z0-9+/=_-])/g,
  /\b[a-f0-9]{64}\b/gi, // hex hashes (SHA-256 etc) — word boundaries for exact match
  /\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, // email addresses
];

/**
 * Replace sensitive patterns in a string with [REDACTED].
 * Applied to exception messages and breadcrumb messages.
 */
export function redactSensitivePatterns(message: string): string {
  if (typeof message !== 'string') return String(message ?? '');
  let scrubbed = message;
  for (const pattern of SENSITIVE_PATTERNS) {
    // Reset lastIndex for global regexes reused across calls
    pattern.lastIndex = 0;
    scrubbed = scrubbed.replace(pattern, '[REDACTED]');
  }
  return scrubbed;
}

// ─── Path prefix scrubbing ──────────────────────────────────────────────────

const PATH_PREFIX_RULES: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\/Users\/[^/]+\//g, replacement: '$HOME/' },
  { pattern: /\/home\/[^/]+\//g, replacement: '$HOME/' },
  { pattern: /C:\\Users\\[^\\]+\\/g, replacement: '%USERPROFILE%\\' },
];

/** Rewrite per-user path prefixes to env-var placeholders. */
export function scrubPathPrefixes(input: string): string {
  if (typeof input !== 'string') return input;
  let out = input;
  for (const { pattern, replacement } of PATH_PREFIX_RULES) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, replacement);
  }
  return out;
}

// ─── Event scrubber ─────────────────────────────────────────────────────────

// Using `any` here because the Sentry Event type comes from different packages
// in main (@sentry/electron/main) vs renderer (@sentry/electron/renderer).
// The scrubber must work with both without importing either — it operates on
// the plain JS shape, not the branded type. This is the ONE place `any` is
// acceptable per internal-reference (non-security-critical plumbing).

/* eslint-disable @typescript-eslint/no-explicit-any */

function stripUnknownContexts(event: any): void {
  if (!event.contexts) return;
  for (const key of Object.keys(event.contexts)) {
    if (!ALLOWED_CONTEXTS.has(key)) {
      delete event.contexts[key];
    }
  }
}

function stripFingerprintingDeviceFields(event: any): void {
  if (!event.contexts?.device) return;
  for (const field of DROPPED_DEVICE_SUBFIELDS) {
    delete event.contexts.device[field];
  }
}

function coarsenOsVersion(event: any): void {
  if (!event.contexts?.os) return;
  const os = event.contexts.os;
  if (typeof os.version === 'string') {
    os.version = os.version.split('.').slice(0, 2).join('.');
  }
  delete os.build;
  delete os.kernel_version;
  delete os.raw_description;
}

function stripUnknownTags(event: any): void {
  if (!event.tags) return;
  for (const key of Object.keys(event.tags)) {
    if (!ALLOWED_TAG_KEYS.has(key)) {
      delete event.tags[key];
    }
  }
}

function scrubFrame(frame: any): void {
  if (frame.filename) frame.filename = scrubPathPrefixes(frame.filename);
  if (frame.abs_path) frame.abs_path = scrubPathPrefixes(frame.abs_path);
}

function scrubSingleExceptionValue(exc: any): void {
  if (exc.value) {
    exc.value = scrubPathPrefixes(redactSensitivePatterns(exc.value));
  }
  if (exc.stacktrace?.frames) {
    for (const frame of exc.stacktrace.frames) {
      scrubFrame(frame);
    }
  }
}

function scrubExceptionValues(event: any): void {
  if (!event.exception?.values) return;
  for (const exc of event.exception.values) {
    scrubSingleExceptionValue(exc);
  }
}

/**
 * beforeSend callback — strips all data except the allowlist.
 * Returns the scrubbed event, or null to drop it entirely.
 */
export function scrubEvent(event: any): any | null {
  if (!event) return null;

  stripUnknownContexts(event);
  stripFingerprintingDeviceFields(event);
  coarsenOsVersion(event);
  event.extra = undefined;
  event.request = undefined;

  if (event.user) {
    const id = event.user.id;
    event.user = { id: id ? redactSensitivePatterns(String(id)) : undefined };
  }

  stripUnknownTags(event);
  scrubExceptionValues(event);

  return event;
}

/* eslint-enable @typescript-eslint/no-explicit-any */

// ─── Breadcrumb scrubber ────────────────────────────────────────────────────

/**
 * beforeBreadcrumb callback — drops console breadcrumbs entirely,
 * strips data payloads from all others, and redacts sensitive patterns
 * in messages.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function scrubBreadcrumb(breadcrumb: any): any | null {
  if (!breadcrumb) return null;

  // Drop console breadcrumbs — too likely to contain logged state objects
  if (breadcrumb.category === 'console') {
    return null;
  }

  // Drop navigation breadcrumbs — route paths leak DM partners and channel
  // membership (e.g. /dm/user-abc123, /servers/xyz/channels/qrs).
  // Defense-in-depth: catches data even if React Router integration is
  // accidentally enabled in the future.
  if (breadcrumb.category === 'navigation') {
    return null;
  }

  // Strip data payload from all breadcrumbs EXCEPT those in an allowlisted
  // category. For allowlisted categories, retain only the fields named in the
  // category's data-key set; everything else is dropped. This keeps the
  // fail-closed default while permitting narrowly-scoped telemetry for specific
  // security signals (e.g. update.pin for #658).
  const allowedDataKeys = ALLOWED_BREADCRUMB_CATEGORY_DATA_KEYS[breadcrumb.category];
  if (allowedDataKeys && breadcrumb.data && typeof breadcrumb.data === 'object') {
    const filtered: Record<string, unknown> = {};
    for (const key of Object.keys(breadcrumb.data)) {
      if (allowedDataKeys.has(key)) {
        filtered[key] = breadcrumb.data[key];
      }
    }
    breadcrumb.data = filtered;
  } else {
    breadcrumb.data = undefined;
  }

  // Redact sensitive patterns in message
  if (breadcrumb.message) {
    breadcrumb.message = redactSensitivePatterns(breadcrumb.message);
  }

  return breadcrumb;
}
