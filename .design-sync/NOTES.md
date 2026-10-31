# design-sync notes — Concord Voice Design System

> **Imported from Concord-Voice-Alpha (@771eb3c) at the repo split.** Paths are rewritten for this repo's `desktop/` root. `CLAUDE.md`, `docs/superpowers/**` and `docs/runbooks/**` references point at Alpha or the private ops repos.

Repo-specific gotchas for future syncs. One bullet per gotcha.

## Build setup (this repo is an Electron app, not a component library)

- **No library `dist` export.** `package.json` `main` points at `dist/main/main.js` (the Electron *main* process) — do NOT let the converter auto-pick it. The bundle is built from a hand-written re-export entry: `desktop/.ds-entry.tsx` (gitignored), passed via `--entry`. Add a component to the sync by adding it to BOTH `.ds-entry.tsx` (named export → `window.ConcordUI.*`) AND `cfg.componentSrcMap`.
- **`--node-modules desktop/node_modules`** (where React 19.2.7 resolves), `--entry desktop/.ds-entry.tsx`, `srcDir: src/renderer`, `tsconfig: tsconfig.json` (relative to PKG_DIR = desktop, NOT the repo-relative path — that resolves wrong).
- **`.d.ts` extraction degrades to `[key: string]: unknown`** in synth-from-src mode (no dist to parse). Real prop contracts are hand-written in `cfg.dtsPropsFor` from the source `*Props` interfaces. When adding a component, copy its source props interface into `dtsPropsFor`.

## Fonts

- Brand fonts live at `desktop/public/branding/Concord-Voice/fonts/`. `index.css` references them with ABSOLUTE `/branding/...` urls (the app serves `public/` at web root), which the converter can't resolve to disk → `[FONT_DANGLING]`.
- Fix: `cfg.cssEntry` points at a gitignored cache copy `src/renderer/styles/.ds-index.css` (same dir as `index.css`, no internal @imports so nothing breaks) with the 13 font urls rewritten `/branding/Concord-Voice/fonts/` → `../../../public/branding/Concord-Voice/fonts/`. **Regenerate this copy whenever `index.css` changes:** `sed 's#/branding/Concord-Voice/fonts/#../../../public/branding/Concord-Voice/fonts/#g' src/renderer/styles/index.css > src/renderer/styles/.ds-index.css` (from `desktop/`).
- The brand display font is **Droidiga** (the angular "LEAVE SERVER?" headings); body is Inter/Lato. All 11 faces ship to `fonts/` after the fix.

## Theme / preview backgrounds (LOAD-BEARING for authoring previews)

- **The default theme is DARK.** `:root` tokens set `--text-primary` to a near-WHITE color. Preview cards render on a WHITE background, so any preview that puts **plain text directly on the card** renders it invisible (white-on-white).
- Components that bring their **own** surface (Modal, ConfirmActionModal — dark panel) render fine on the white card.
- Components without their own surface (CustomSelect, ContextMenu items, EnforcementMenuItems, plain-text context rows) MUST be wrapped in a themed surface in their preview: `<div style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)', padding: 16, borderRadius: 8 }}>…</div>`. This is both correct (their real home is the dark app surface) and makes text visible.

## Providers

- **Modal / ConfirmActionModal / ImageCropEditor need `ModalProvider`.** `Modal` calls `useModalStack()` which THROWS `'must be used within a ModalProvider'`. `cfg.provider = { component: "ModalProvider" }` (exported from `ui/ModalContext.tsx`, added to `.ds-entry.tsx`) wraps every preview — harmless for non-modal components.
- Modals portal to `document.body` (#2087) and set `#root` inert. `cardMode: single` in `cfg.overrides` keeps them contained in the card.

## Component-specific

- **UpdateBanner** takes no props; it's driven by `globalThis.electron.onUpdateAvailable/onUpdateDownloadProgress/onUpdateDownloaded` and stays hidden until an update event fires. Its preview must stub `globalThis.electron` before rendering to show any state.
- **The 4 store/electron-coupled overlays** (ShortcutOverlay, ForceUpdateOverlay, ConnectionLostOverlay, ChannelSwitcher) are wave-2 — deferred; they read Zustand stores / `globalThis.electron` and need stubs in their previews.

## Playwright / render check

- Chromium **build 1223** is cached at `~/Library/Caches/ms-playwright/chromium_headless_shell-1223/`. The repo's playwright 1.61.1 pins build 1228 (not cached). Reuse the cache: `playwright@1.61.1` installed in `.ds-sync/` with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`, and set `DS_CHROMIUM_PATH=~/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell` before validate/capture.

## Wave 2 — store/electron-coupled overlays (how each preview is seeded)

All 4 are prop-less and state-driven; previews seed store state / stub electron at module load. The 7 stores + `MemoryRouter` are exported from `.ds-entry.tsx` (lowercase store names → NOT component cards). `cfg.provider = ModalProvider > MemoryRouter` (MemoryRouter satisfies ChannelSwitcher's `useNavigate`).

- **ShortcutOverlay** — `useKeyboardShortcutStore.setState({ overlayOpen: true })`. Store ships `DEFAULT_SHORTCUTS`, so no data needed. Uses Modal → needs ModalProvider.
- **ForceUpdateOverlay** — `useClientConfigStore.setState({ minVersion: '99.0.0', lastFetchedAt: <truthy> })` + stub `globalThis.electron.getVersion` (→ old version) and the `onUpdate*` subscribes. **Has a 1000ms anti-flicker `ready` grace timer** the capture doesn't wait for — the preview clamps long `setTimeout` delays to 0 so it fires immediately.
- **ConnectionLostOverlay** — `useConnectionStore.setState({ phase, diagnostics })`. **Valid `phase` values: `stable | grace_period | preflight | recovery_a | recovery_b | fatal`** (NOT `failed` — that hits the default empty branch). `recovery_a` = server issue (Retry), `fatal` = unrecoverable (Restart/Exit). `diagnostics` = `{ internet, serverReachable, tokenValid: CheckResult('ok'|'failed'), sessionRevoked: boolean }`.
- **ChannelSwitcher** — seed 5 stores: `useKeyboardShortcutStore({channelSwitcherOpen:true})`, `useServerStore({servers:[{id,name}]})`, `useChannelStore({currentServerId, channels:[{id,name,type:'text',server_id}]})`, `useDMStore({conversations:[{id,isPersonal:false,isGroup,name?,participants:[{userId,username,displayName}]}]})`, `useUserStore({user:{id}})`.

## Known render warns (triaged benign — do NOT treat as new on re-sync)

- `[RENDER_THIN]` on ConnectionLostOverlay, ContextMenu, ForceUpdateOverlay: "rendered height 0px". These are `position: fixed` / portal overlays whose content escapes normal-flow measurement — the screenshots confirm they render correctly. Benign.
- Fixed-overlay cards (ForceUpdateOverlay, ConnectionLostOverlay) show the panel title slightly clipped at the card top in the composite contact sheet — a fixed-position-in-card artifact; the live `.review.html` centers them properly. Cosmetic only.
- `[GRID_OVERFLOW]` on EnforcementMenuItems was resolved by `cardMode: single` (primaryStory ServerContext).

## Component notes

- **CustomSelect** ships a NATIVE `<select>` (className `custom-select` has no CSS anywhere in the repo) — the honest render is browser-native, styled only by the surrounding surface. Not a bundling miss.

## Re-sync risks

- `.ds-entry.tsx` and `.ds-index.css` are gitignored build inputs a fresh clone must regenerate:
  - **`.ds-index.css`**: the `sed` under "Fonts" above.
  - **`desktop/.ds-entry.tsx`**: named re-exports of the 13 components in `cfg.componentSrcMap` (all `export { default as X }` except `EnforcementMenuItems` which is a named export), PLUS these non-card exports the previews/provider need: `ModalProvider` (from `ui/ModalContext`), the 7 stores (`useKeyboardShortcutStore`, `useClientConfigStore`, `useConnectionStore`, `useChannelStore`, `useServerStore`, `useDMStore`, `useUserStore`), and `MemoryRouter` (from `react-router-dom`). Paths are `./src/renderer/...`.
- The scoped set is 13 components (9 presentational primitives + 4 mocked overlays) — NOT the full 214-component tree. Most feature components can't render standalone (Zustand/e2ee/WebSocket/IPC coupling). Floor-card authoring of more components is available on any re-sync.
- Wave-2 previews depend on internal store field names / phase values / the `globalThis.electron` bridge shape. If the app refactors any of those (renamed store field, changed `ConnectionPhase` values, changed updater IPC), the affected preview silently renders empty — re-verify the 4 overlays on a re-sync after store/updater changes.
