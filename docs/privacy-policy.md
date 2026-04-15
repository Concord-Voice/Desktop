# Concord Voice — Privacy Policy

> **Status:** Draft. This document describes the privacy posture of Concord
> Voice as implemented in the codebase. Legal review pending before public
> release.

## Data we collect

[To be expanded as features ship. Currently includes:]

- Account data: email, display name, password hash (Argon2id), profile preferences.
- Messages and channel content: end-to-end encrypted; the server stores
  ciphertext only and cannot read message contents.
- Crash reports: see "Crash reports (Sentry)" below.

## Crash reports (Sentry)

Crash reports sent to Sentry use a client identifier computed from your
installation's hardware and your account UUID. The hardware components are
retrieved only at runtime, never stored, transmitted to Concord's servers,
or logged. Concord cannot reconstruct the identifier from any data we
possess, and Sentry cannot reconstruct it from the event payload. To
request deletion of your Sentry data, your client application transiently
provides your current identifier to us for one-time use in the deletion
request. Erasure is scoped to events tagged with your current identifier;
if your hardware has changed since events were captured, older events
cannot be targeted.

Crash reports include redacted stack traces and runtime context but exclude:

- Message content (encrypted; never available outside the client)
- Disk volume UUID and motherboard serial (used only as inputs to the
  client identifier hash; never transmitted)
- File paths under your home directory (rewritten to `$HOME/` or
  `%USERPROFILE%\` before transmission)
- Device fingerprinting fields (`device.model`, `device.cpu_description`,
  timezone, locale, OS build, etc.)

Crash reporting is opt-in. You can disable it at any time via Settings →
Privacy and request erasure of previously-collected events.

## Erasure (GDPR Article 17)

You can request deletion of your Sentry data via Settings → Privacy. The
request is authenticated to your account; the server uses the identifier
you supply transiently to call Sentry's deletion API and never persists
the identifier. Account deletion is a separate option that also erases
crash reports.

## Contact

For privacy questions or data subject requests, contact: privacy@concordvoice.com
