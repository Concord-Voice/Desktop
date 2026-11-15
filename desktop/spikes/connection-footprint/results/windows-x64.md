# Connection footprint spike — Windows x64

Spec: `docs/superpowers/specs/2026-11-09-86-connection-context-isolation-design.md` §5 T0, §9.
Harness: `../main.mjs` (see `../README.md`). Nothing on this page was measured, so it holds no numbers; the Not measured rows are not estimates.

| row | result |
|---|---|
| Per-connection delta, working set (views 0→1→2→3), cold | NOT MEASURED — executor has macOS arm64 only; no Windows/Linux host available 2026-11-09 |
| Per-connection delta, working set (views 0→1→2→3), login-idle | NOT MEASURED — executor has macOS arm64 only; no Windows/Linux host available 2026-11-09 |
| Per-connection delta, working set (views 0→1→2→3), logged-in-idle | NOT MEASURED — executor has macOS arm64 only; no Windows/Linux host available 2026-11-09 |
| Private memory per connection (`privateBytes`, win32 only) | NOT MEASURED — executor has macOS arm64 only; no Windows/Linux host available 2026-11-09 |
| Cold start `whenReady`→`did-finish-load` per view, and delta per added connection | NOT MEASURED — executor has macOS arm64 only; no Windows/Linux host available 2026-11-09 |
| `session/` disk per connection (`du`) | NOT MEASURED — executor has macOS arm64 only; no Windows/Linux host available 2026-11-09 |
| Idle CPU per hidden view, `backgroundThrottling` true | NOT MEASURED — executor has macOS arm64 only; no Windows/Linux host available 2026-11-09 |
| Idle CPU per hidden view, `backgroundThrottling` false | NOT MEASURED — executor has macOS arm64 only; no Windows/Linux host available 2026-11-09 |
| Hidden-view timer throttling vs websocket heartbeat (missed? interval observed) | NOT MEASURED — executor has macOS arm64 only; no Windows/Linux host available 2026-11-09 |
| `-webkit-app-region: drag` works inside a child view | NOT MEASURED — executor has macOS arm64 only; no Windows/Linux host available 2026-11-09 |
| Child webContents destroyed on `BaseWindow.close()` | NOT MEASURED — executor has macOS arm64 only; no Windows/Linux host available 2026-11-09 |
| `titleBarOverlay` hit-testing over a child view (min/max/close clickable; no view steals the overlay region) | NOT MEASURED — executor has macOS arm64 only; no Windows/Linux host available 2026-11-09 |
| Content protection (`setContentProtection(true)` on the `BaseWindow` before any child loads) excludes every child view from capture | NOT MEASURED — executor has macOS arm64 only; no Windows/Linux host available 2026-11-09 |

## ADR claims that stay open

- `titleBarOverlay` hit-testing with `WebContentsView` children (the overlay buttons are drawn by the `BaseWindow`; whether a full-bounds child view intercepts their hit-test is unverified).
- Content protection on Windows under `BaseWindow` composition (spec §3.4 applies it before any child loads; `WDA_EXCLUDEFROMCAPTURE` coverage of child views is unverified).
- `-webkit-app-region: drag` inside a child view on Windows.
- Footprint, cold-start and idle-CPU numbers for Windows; the macOS numbers do not transfer (different allocator, `privateBytes` available, no occlusion-driven visibility).
- Hidden-view throttling vs heartbeat on Windows (visibility there changes only on minimise/`hide()`, not occlusion, per Electron's Page Visibility notes).
- Child webContents survival on `BaseWindow.close()` on Windows (Electron docs say they are not destroyed; unverified on this platform).

## To close them

- Run the README commands on a Windows x64 host with the same Electron 45.0.0 lockfile; `--check=platform` covers close-survival; overlay hit-testing, drag and content protection need a person at the machine (capture with a second app to test protection).
