import type { PinConfig } from './updatePinning';

// ⚠ SECURITY-CRITICAL — TLS pin configuration for the update feed. ⚠
//
// This file is the sole source of truth for which TLS certs are trusted to
// serve the Concord Voice electron-updater feed on api.concordvoice.chat.
// Every change requires:
//   1. PR description linking to internal-reference
//   2. Security reviewer sign-off (enforced via CODEOWNERS)
//   3. The runbook's operational checks (SPKI computation, CF upload)
//
// Computing a new SPKI value:
//   node scripts/compute-spki.mjs <path-to-cert.pem>
//
// Semgrep rule `concord-cert-pinning-config-import-scope` restricts imports of
// this file to updatePinning.ts + main.ts + tests.

export const PIN_CONFIG: PinConfig = {
  pinnedHosts: ['api.concordvoice.chat'] as const,
  primaryPins: [
    // Current production leaf SPKI SHA-256 (Let's Encrypt E8, via CloudFlare edge).
    // Measured 2026-04-20; see spec §14 Resolution 0.6. This is a public-key
    // fingerprint, not a secret — reproducible by anyone connecting to the host.
    '53257bb4d6ddca461e74b403aeabe43e2b957ff78b4c893a8d4cb6f26762281b', // pragma: allowlist secret
  ] as const,
  fallbackPins: [
    // Pre-staged backup keypair SPKI SHA-256. The corresponding RSA-4096
    // private key was generated offline during the Appendix A key ceremony
    // (2026-04-20) and is stored exclusively in the ops vault — it is never
    // committed to this repo, never on any VM, and never in CI secrets.
    //
    // This pin only comes into play during a planned key-rotation cycle: when
    // the primary cert's keypair is rotated, the backup key is retrieved from
    // the vault, a new LE cert is issued against it via the runbook procedure,
    // and the roles swap (see internal-reference §4).
    //
    // If you change this value, the rotation runbook MUST be updated in the
    // same PR so the swap procedure references the correct vault identifier.
    'b03ab5df6d5ff66d9ab54ea0ef83e032a14c533e973edb70f8d24214e70eeb37', // pragma: allowlist secret
  ] as const,
} as const;
