# Connection footprint spike — Linux x64

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
| `titleBarOverlay` hit-testing over a child view (X11) | NOT MEASURED — executor has macOS arm64 only; no Windows/Linux host available 2026-11-09 |
| Wayland framed chrome (`buildBrowserWindowConfig` returns the framed base config on Wayland) with child views | NOT MEASURED — executor has macOS arm64 only; no Windows/Linux host available 2026-11-09 |

## ADR claims that stay open

- `titleBarOverlay` hit-testing with `WebContentsView` children on X11.
- Wayland framed chrome under `BaseWindow` composition (server-side vs client-side decorations around a `contentView` with children).
- `-webkit-app-region: drag` inside a child view on X11 and on Wayland.
- Footprint, cold-start and idle-CPU numbers for Linux.
- Hidden-view throttling vs heartbeat on Linux.
- Child webContents survival on `BaseWindow.close()` on Linux.

## To close them

- Run the README commands on a Linux x64 host under both an X11 and a Wayland session (`XDG_SESSION_TYPE`), same Electron 45.0.0 lockfile.
