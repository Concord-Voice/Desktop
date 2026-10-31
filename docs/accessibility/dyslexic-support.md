# Dyslexic Support (Accessibility ▸ Display)

**Enable Dyslexic Support** forces the [OpenDyslexic](https://github.com/antijingoist/opendyslexic) typeface across the app. It overrides both the user's font pick and any theme-bundled font. It is the top layer of the effective-font resolver (`utils/ui/effectiveFont.ts`).

- **Toggle:** Settings ▸ Accessibility ▸ Display ▸ "Enable Dyslexic Support".
- **Effect:** every font layer becomes OpenDyslexic: body text, headings, navigation, messages and the titlebar wordmark (one settings sink, one attribute per layer). The typeface controls in Appearance ▸ Application Font lock (the mode choice and every font option, in both One Font and Font by Area); Font Size in the same section stays usable.
- **Locked picker (WCAG 1.3.1 / 3.3.2):** font options become `aria-disabled`, with a visible explanation (`aria-describedby`). A back-link moves focus to the toggle. Options stay native `<button>`s and remain keyboard-reachable/announced.
- **Turning it off restores the previously-active font** — the toggle never overwrites the stored pick (`DYSLEXIC_WRITES_APPFONT = false`). The pure resolver just stops overriding.
- **Self-hosted:** the app bundles OpenDyslexic (`public/branding/Concord-Voice/fonts/`, no CDN). See `fonts/LICENSES.md`.

Implemented in #1644 (epic #1641), on the #1642 resolver + #1643 picker-consumption foundation.
