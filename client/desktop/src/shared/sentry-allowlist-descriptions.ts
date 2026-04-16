/**
 * Human-readable descriptions for every field the Sentry scrubber allowlist
 * permits. Rendered in Settings → Privacy & Security → Crash Reporting as
 * the "What we collect" expander.
 *
 * CONTRACT: every key in ALLOWED_CONTEXTS and ALLOWED_TAG_KEYS MUST have an
 * entry here, and no orphan entries may exist. Enforced by the Vitest suite
 * `sentry-allowlist-descriptions.test.ts`. Any change to this file requires
 * bumping TELEMETRY_POLICY_VERSION — see sentry-policy-version.ts.
 */

import { TELEMETRY_POLICY_VERSION } from './sentry-policy-version';

export interface AllowlistMeta {
  /** Must equal TELEMETRY_POLICY_VERSION; enforced by the spec suite. */
  version: number;
  /** ISO 8601 date of the most recent policy bump. Cosmetic; not CI-enforced. */
  lastUpdated: string;
  /** One-sentence headline shown at the top of the disclosure. */
  summary: string;
  /** Changelog, newest first. One entry per policy bump. */
  changelog: Array<{ version: number; date: string; change: string }>;
}

export interface AllowlistCategory {
  title: string;
  intro: string;
  /** Key → human description. Keys must match the allowlist in sentry-scrubbers.ts. */
  fields: Record<string, string>;
}

export const ALLOWLIST_META: AllowlistMeta = {
  version: TELEMETRY_POLICY_VERSION,
  lastUpdated: '2026-04-16',
  summary:
    'No message content, encryption keys, IP addresses, or personal information are ever sent. Only the technical details below reach Sentry.',
  changelog: [
    {
      version: 2,
      date: '2026-04-16',
      change: 'Introduced client-bundled policy version and machine-verified disclosure (#661).',
    },
    {
      version: 1,
      date: '2026-03-01',
      change: 'Initial allowlist shipped with opt-in consent (#618).',
    },
  ],
};

export const ALLOWLIST_CATEGORIES: Record<'contexts' | 'tags', AllowlistCategory> = {
  contexts: {
    title: 'About the app and device',
    intro:
      'Technical details about your desktop app and operating system — used to tell crashes on different builds or platforms apart.',
    fields: {
      os: 'Your operating system family and coarse version (e.g. macOS 14, Windows 11) so we can distinguish platform-specific crashes.',
      browser:
        'The Chromium version used by the Electron shell, so we can correlate crashes with web-runtime changes.',
      electron:
        'The Electron framework version and whether this is a packaged build or a development run.',
      device:
        'Non-identifying device metadata (CPU architecture, memory class). Hardware fingerprints such as model, serial, and screen resolution are stripped before sending.',
      runtime:
        'The JavaScript runtime version (V8) the app is using, so we can diagnose crashes tied to runtime behavior.',
      app: 'The installed Concord app name and build identifier, used to group crashes by release.',
    },
  },
  tags: {
    title: 'Crash classification tags',
    intro:
      'Short labels attached to each event so we can group related crashes. None of these carry content or identity.',
    fields: {
      environment: 'Whether the event came from a production or development build.',
      release:
        'The specific Concord desktop version that produced the crash (e.g. concord-desktop@0.1.20).',
      level: 'How severe the event is (error, warning, info) for prioritisation.',
      transaction:
        'The high-level code path the crash occurred in (e.g. "mainWindow.create"). Never includes DM partners or channel IDs.',
      'electron.process':
        'Which Electron process the event came from (main, renderer, or preload).',
      handled: 'Whether the crash was caught by application code or propagated uncaught.',
      boundary: 'Which React error boundary intercepted the event, if any.',
    },
  },
};
