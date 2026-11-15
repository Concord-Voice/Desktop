# #218 — Attested CycloneDX SBOM per Desktop release artifact

Issue: #218

## Intent

Release verification now refuses a Desktop tag build unless each release artifact
`concord-voice-<label>-v<version>` holds `<artifact>.cdx.json` at its top level, as
a CycloneDX JSON SBOM with a build-provenance attestation from `release.yml` at the
tag and SHA. Every other file in every run artifact must also be attested.

## Design

- `release-build` is unchanged. Its steps must stay equal to `build-desktop.yml`.
- New job `leg-digests` (`contents: read`). It records the SHA-256 of every file in
  each leg before the scanner runs.
- New job `sbom` (`contents: read`, no `id-token`). It installs syft 1.55.0, pinned by
  sha256, and downloads the six release artifacts. Then it runs
  `.github/scripts/generate-desktop-sbom.sh` for each one and uploads the
  intermediate artifact `desktop-sboms`.
  - The script unpacks one installer per leg: Windows `*Setup.exe` through 7z (NSIS
    keeps the app in `app-<arch>.7z`), the macOS `.zip`, or the Linux `.deb`.
  - It extracts `app.asar` with a stdlib Python reader, so no npm code runs.
  - It scans the tree with the syft `image` cataloger set (installed
    `node_modules/*/package.json`).
  - syft does not catalog `.node` addons, so the script adds each one, with its SHA-256.
  - It fails if the SBOM lists no npm package.
- New job `attach-sbom`. It is a matrix over the six labels, with `id-token` and
  `attestations: write`, and no checkout.
  - It downloads the leg and the SBOMs, and refuses a leg whose files differ from
    the `leg-digests` record.
  - It runs the same CycloneDX check as release verification, attests the SBOM,
    and re-uploads the leg with `overwrite: true`. The installer files keep their
    digests and their existing attestations.
- The `desktop-sboms` files are byte-identical to the attested copies, so they
  verify by digest.
- `verify-unsigned-desktop.py` now allows the three jobs. It enforces:
  - the scanner job is read-only;
  - the job order;
  - no `defaults`;
  - `attach-sbom` covers every packaging leg;
  - `leg-digests` and `attach-sbom` match a pinned sha256 of each parsed job.

## Approaches

1. **Chosen: scan the built installers in a separate job, then attest and re-upload.**
   Keeps `release-build` and its drift check untouched.
2. Generate the SBOM inside `release-build`. Rejected: the issue requires a job
   without `id-token`, and the step list must match `build-desktop.yml`.
3. Scan `desktop/package-lock.json`. Rejected: it lists dev dependencies, not
   what the installer contains.

## Calls made here

- One SBOM per leg, from the `.zip` (macOS) or `.deb` (Linux). The `.dmg`, `.rpm`
  and AppImage hold the same app.
- The issue says "the existing attestation job". The attestation runs in a new job
  with the same pinned attest action, because the SBOM exists only after
  `release-build`.
