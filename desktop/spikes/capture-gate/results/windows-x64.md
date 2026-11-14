# Capture-gate probe — Windows x64

Spec: `docs/superpowers/specs/2026-11-09-87-capture-lease-and-resource-budgets-design.md` §6 T0.
Harness: `../main.mjs` (see `../README.md`). Nothing on this page was measured, so it holds no
results; a NOT MEASURED row is not an estimate, and the macOS results do not transfer.

| row | observed | run count | note |
|---|---|---|---|
| 1 (`--check=true` / `--check=false`): request handler fires on every `getUserMedia` | NOT MEASURED — executor has macOS arm64 only; no Windows/Linux host available 2026-11-11 | 0 / 0 | |
| 2: denied request → renderer error name | NOT MEASURED — executor has macOS arm64 only; no Windows/Linux host available 2026-11-11 | 0 / 0 | |
| 3: `chromeMediaSource: 'desktop'` and `getDisplayMedia` → permission string | NOT MEASURED — executor has macOS arm64 only; no Windows/Linux host available 2026-11-11 | 0 / 0 | |
| 4: `reload()` alone vs `forcefullyCrashRenderer()` + `reload()` with a `beforeunload` veto | NOT MEASURED — executor has macOS arm64 only; no Windows/Linux host available 2026-11-11 | 0 / 0 | |
| 5: `--use-fake-ui-for-media-stream` → which handlers fire | NOT MEASURED — executor has macOS arm64 only; no Windows/Linux host available 2026-11-11 | 0 / 0 | |
| 6: parented `showMessageBox` modality, `signal` abort | NOT MEASURED — executor has macOS arm64 only; no Windows/Linux host available 2026-11-11 | 0 / 0 | |
| 7: hidden `WebContentsView` `document.visibilityState` | NOT MEASURED — executor has macOS arm64 only; no Windows/Linux host available 2026-11-11 | 0 / 0 | |

## What stays open in the ADR

- **Row 6 modality on Windows.** Whether a `showMessageBox` parented to the `BaseWindow` blocks
  input to the connection views while it is open. F7's `busy` split stays closed until this is
  measured. Measure it with a real pointer at the machine: `sendInputEvent` bypasses the OS
  window and cannot answer it (see the macOS note).
- **Access-key reach on Windows.** Whether `normalizeAccessKeys: true` makes Join reachable through
  its access key (`&Join`) in the native box.
- **`signal` abort on Windows.** Whether `controller.abort()` closes the parented box and resolves
  it as `cancelId` (Stay), as it does on macOS.
- **Row 4's lost same-task `reload()` on Windows.** On macOS, `reload()` in the same task as
  `forcefullyCrashRenderer()` was lost and the view stayed crashed. Unverified here.
- **Rows 1, 3, 5 and 7 on Windows.** The permission routing and the hidden-view visibility were
  measured on macOS only.

## To close them

Run the README commands on a Windows x64 host with the same Electron 45.0.0 lockfile. Rows 1–5 and 7
run unattended. Row 6's modality and access-key checks need a person at the machine.
