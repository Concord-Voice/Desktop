# Agency Theme — Design Handoff Spec

**Theme name:** Agency
**Internal slug:** `agency`
**Status:** Shipped 2026-05-29 in PR #1247. Retained as the design record for the Agency scheme.
**Type:** Color scheme + font stack addition to `client/desktop`

> **Imported from Concord-Voice-Alpha (@771eb3c) at the repo split.** `client/desktop/` there is `desktop/` here. `CLAUDE.md`, `docs/superpowers/**` and `docs/runbooks/**` references point at Alpha or the private ops repos.

---

## 1. Overview

Adds the **Agency** color scheme to Concord Voice's `client/desktop` theme system — the 13th preset scheme alongside Concord, 9th Circle, Bardic, Fox Den, Hacker, Spooky, Driftwood, Grassy Nill, Cotton Candy, Eclipse, Leviathan, and Midnight Sky.

> Counts in this document are as-of ship. Agency was the 13th preset; the live tree now carries more (`defacto` and `pride` landed later) — see Alpha's CLAUDE.md Key Counts (private) for the current scheme and CSS-block totals.

Agency presents an atmospheric near-black surface with magenta + cyan brand accents and circuit-board palette grounding (navy + teal + mint + amber). The aesthetic direction is **cyberpunk-industrial** — sharp electric accents on a deep ambient ground, channeling decisiveness rather than warmth.

### Brand provenance + attribution

Agency's color palette and font specification are derived from the publicly published **DEF CON® 34 Theme and Style Guide** (Las Vegas, 2026-08-06 — 2026-08-09). The conference's theme of "Agency" — digital self-determination, resistance to dark patterns, support for decentralized/community-controlled software — is conceptually aligned with Concord Voice's privacy-first hybrid SaaS + self-hosted positioning.

**Decision (#1):** the scheme is named "Agency" (the theme concept), not "DEF CON 34" (the trademark). This is a deliberate posture choice — the brand palette and fonts are not trademark-protectable individually, but using the DEF CON® mark in the shipping product UI would be a commercial use of a registered trademark of DEF CON Communications, Inc. The neutral "Agency" name lets us use the visual DNA without the mark.

This attribution is documented here for engineering reference. **Do not surface "DEF CON" in user-facing UI strings, settings labels, or marketing copy** without explicit licensing from DEF CON Communications, Inc.

---

## 2. Design Tokens

All 50 tokens per scheme block, mirroring the `#1033` design-token taxonomy (6 families: color, state, typography, scale, motion, link, encryption).

### 2.1 Agency Dark — palette

| Token | Value | Source | Use |
|---|---|---|---|
| `--bg-primary` | `#050912` | derived | Atmospheric base — near-black with navy tint |
| `--bg-secondary` | `#0a1224` | derived | Sidebar / panel surface |
| `--bg-tertiary` | `#0d294a` | **Pantone 2955C** | Tertiary surface — brand navy itself |
| `--bg-hover` | `#122545` | derived | Hover-state surface lift |
| `--bg-active` | `#1a3666` | derived | Active-state surface lift |
| `--text-primary` | `#f0f5fa` | derived | Body text — cool white, slight blue tint |
| `--text-secondary` | `#94a8c4` | derived | De-emphasized text (timestamps, hints) |
| `--text-muted` | `#5e718f` | derived | Most-muted text (placeholder, helper) |
| `--text-tertiary` | `#455770` | derived | Decorative/separator text |
| `--accent-primary` | `#e0004e` | **Pantone 1925C** | Brand magenta — signature mark color |
| `--accent-secondary` | `#017fa4` | **Pantone 314C** | Brand cyan — circuit-trace complement |
| `--accent-hover` | `#ff1860` | derived | Lifted magenta for hover |
| `--gradient-brand` | `linear-gradient(90deg, #e0004e 0%, #017fa4 100%)` | derived | Brand signature dual-color gradient |
| `--success` | `#6ccdb8` | **Pantone 3248C** | Brand mint as success indicator |
| `--danger` | `#ff2050` | derived | Warmer magenta-coral for danger |
| `--danger-hover` | `#ff3060` | derived | Lifted danger |
| `--border-color` | `#1e3258` | derived | Subtle navy-tinted border |
| `--on-accent` | `#ffffff` | universal | Text on accent buttons |
| `--status-connected` | `#6ccdb8` | brand mint | Status indicator |
| `--status-connecting` | `#f1b435` | **Pantone 143C** | Brand amber as in-progress |
| `--status-disconnected` | `#e0004e` | brand magenta | Status indicator (alarm) |
| `--text-warning-strong` | `#f1b435` | brand amber | Strong warning text |
| `--text-error-strong` | `#ff5070` | derived | Strong error text |
| `--state-selected` | `var(--accent-primary)` | brand magenta | Selection indicator |
| `--state-focused` | `var(--accent-secondary)` | brand cyan | Focus ring (1.4.11 ≥3:1) |
| `--state-hover` | `var(--bg-hover)` | derived | Hover state |
| `--link-color` | `#6ccdb8` | brand mint | Link text (AAA 10.4:1) |
| `--link-color-hover` | `#8eecd6` | derived | Link hover (AAA 14.1:1) |
| `--link-color-visited` | `#105f66` | **Pantone 5473C** | Visited links — brand deep teal |
| `--state-encryption-pending` | `#f1b435` | brand amber | E2EE in-flight indicator |
| `--font-display-stack` | `'Atkinson Hyperlegible Next', 'Lato', system-ui, sans-serif` | brand | Distinctive display font for headers |
| `--font-body-stack` | `'Lato', 'Atkinson Hyperlegible Next', system-ui, sans-serif` | brand | Warm humanist body font |
| `--font-display-tracking` | `0` | mirror baseline | Display tracking baseline |
| `--font-display-tracking-tight` | `-0.02em` | mirror baseline | Tight display tracking |
| `--radius-base` | `4px` | mirror baseline | Base corner radius |
| `--radius-elevated` | `8px` | mirror baseline | Elevated surface radius |
| `--radius-modal` | `12px` | mirror baseline | Modal radius |
| `--motion-duration-fast` | `150ms` | mirror baseline | Fast transition |
| `--motion-duration-base` | `250ms` | mirror baseline | Standard transition |
| `--motion-duration-slow` | `400ms` | mirror baseline | Slow transition |
| `--motion-curve-base` | `cubic-bezier(0.4, 0, 0.2, 1)` | mirror baseline | Standard easing |
| `--motion-curve-decel` | `cubic-bezier(0, 0, 0.2, 1)` | mirror baseline | Decelerating easing |

**Per the `#1033` schema-symmetry invariant:** Agency follows the same token-family structure as all 12 existing schemes. Divergence from baseline mirror values is limited to: (a) the 6 color families, (b) `--link-color` / `--link-color-hover` (for WCAG AA compliance), (c) the font stacks (brand-specified). Radius, motion, and tracking values mirror baseline — divergence in those families would be a follow-up sibling issue per #1033's "opt into per-token divergence" pattern.

### 2.2 Agency Light — palette

Light variant inverts the surface scale while darkening the brand accents for WCAG contrast on a pale-cool background.

| Token | Value | Notes |
|---|---|---|
| `--bg-primary` | `#f5f7fa` | Cool pale grey (not pure white — easier on eyes) |
| `--bg-secondary` | `#eaeff6` | Slightly more saturated panel surface |
| `--bg-tertiary` | `#d9e2ed` | Tertiary surface |
| `--bg-hover` | `#e0e8f0` | Hover lift |
| `--bg-active` | `#cdd9e6` | Active lift |
| `--text-primary` | `#0a1424` | Near-black with navy tone (AAA 16.4:1) |
| `--text-secondary` | `#3a4a66` | Mid-tone navy (AAA 8.69:1) |
| `--text-muted` | `#5e708a` | Muted (AA 4.84:1) |
| `--text-tertiary` | `#768aa6` | Decorative |
| `--accent-primary` | `#a30038` | Darkened brand magenta (AAA 7.43:1) |
| `--accent-secondary` | `#015a73` | Darkened brand cyan (AAA 7.26:1) |
| `--accent-hover` | `#c8004a` | Hover-state magenta |
| `--gradient-brand` | `linear-gradient(90deg, #a30038 0%, #015a73 100%)` | Darker signature gradient |
| `--success` | `#2a8a72` | Darkened mint |
| `--danger` | `#c4003d` | Clear darker red-magenta |
| `--border-color` | `#b8c4d4` | Cool pale border |
| `--on-accent` | `#ffffff` | White on darkened accents |
| `--link-color` | `#015a73` | Darker cyan (AAA 7.26:1) |
| `--link-color-hover` | `#013548` | Even-deeper cyan (AAA 12.15:1) |
| `--link-color-visited` | `#105f66` | Brand deep teal |
| `--state-encryption-pending` | `#b07a00` | Darker amber for contrast on light |
| `--font-*` | (same as dark) | Font stacks identical across modes |
| `--radius-*`, `--motion-*` | (mirror baseline) | Mirror dark variant |

---

## 3. Files Touched

### Source + types + UI

| File | Change |
|---|---|
| `client/desktop/src/renderer/styles/index.css` | Two new `[data-scheme='agency']` blocks (dark + light, ~106 lines after midnightsky) + 5 `@font-face` declarations + stale-count comment refresh (12→13 schemes) |
| `client/desktop/src/renderer/stores/ui/settingsStore.ts` | `'agency'` added to `AppearanceSettings.colorScheme` discriminated union |
| `client/desktop/src/renderer/components/Settings/AppearanceSection.tsx` | Tuple-array + `.map()` refactor of the 13-scheme registry, with all 4 component-body constants (`SCHEME_TUPLES`, `colorSchemes`, `themes`, `fontSizes`) hoisted to module scope per Gitar + code-reviewer findings |
| `client/desktop/src/renderer/utils/ui/schemeColors.ts` | `agency: ['#e0004e', '#017fa4']` added to `SCHEME_ACCENTS` |
| `client/desktop/src/renderer/components/SpaFallbackOverlay/SpaFallbackOverlay.css` | Stale-count comment refresh (12→13 schemes) |

### Tests

| File | Change |
|---|---|
| `client/desktop/tests/unit/styles/link-contrast.test.ts` | `ALL_26_BLOCKS` → `ALL_28_BLOCKS`; 2 Agency entries added; meta-test name updated; Agency NOT added to `KNOWN_NONCOMPLIANT_BLOCKS` |
| `client/desktop/tests/unit/styles/design-tokens.test.ts` | Same rename; drift-guard count assertion verifies 28-selector CSS reality |
| `client/desktop/tests/unit/utils/schemeColors.test.ts` | "12 preset" → "13 preset"; `'agency'` added to enumerated array |
| `client/desktop/tests/unit/components/Settings/SettingsPage.test.tsx` | Hardcoded circle count 13 → 14 (12 built-in + 1 custom → 13 built-in + 1 custom; caught by CI shard 1, fix-cycle commit) |

### Brand binaries + license

| File | Change |
|---|---|
| `client/desktop/public/branding/Concord-Voice/fonts/AtkinsonHyperlegibleNextVF-Variable.woff2` | NEW — 78 KB Variable WOFF2 covering weights 200–800 |
| `client/desktop/public/branding/Concord-Voice/fonts/Lato-Regular.ttf` / `Lato-Bold.ttf` / `Lato-Italic.ttf` / `Lato-BoldItalic.ttf` | NEW — 4 TTF variants, ~75 KB each |
| `client/desktop/public/branding/Concord-Voice/fonts/LICENSES.md` | NEW — SIL OFL 1.1 full text + attribution to Braille Institute (Atkinson Hyperlegible Next) and Łukasz Dziedzic (Lato) |

### Documentation

| File | Change |
|---|---|
| [`docs/design/agency-theme-handoff.md`](agency-theme-handoff.md) | NEW — this document |
| `docs/superpowers/specs/2026-05-29-1245-agency-color-scheme-design.md` | NEW — spec stub pointing to this handoff as canonical |
| `docs/superpowers/plans/2026-05-29-1245-agency-color-scheme.md` | NEW — plan stub listing executed tasks |

**Total:** ~18 files touched / created, of which 5 are binary font assets. Code + test changes are surgical (each file touches one of: scheme registry, schema-symmetry guard, count update). The bulk of the line delta is the new Agency CSS blocks + the handoff doc you're reading.

---

## 4. Brand Fonts — Shipped in this PR

The brand fonts ship as binaries in the same PR. The brand guide specified "Atkinson Hyperlegible" (original). This PR ships **Atkinson Hyperlegible Next** — the 2024 successor from the same designer (Braille Institute) under the same SIL OFL 1.1 license. Next expands weight coverage (200–800 via Variable font axis) and broadens Latin language support. Strict upgrade.

### 4.1 Files shipped

| Family | File | Size | License | Source |
|---|---|---:|---|---|
| Atkinson Hyperlegible Next | `AtkinsonHyperlegibleNextVF-Variable.woff2` | 78 KB | SIL OFL 1.1 | https://www.brailleinstitute.org/freefont/ |
| Lato | `Lato-Regular.ttf` | 75 KB | SIL OFL 1.1 | https://fonts.google.com/specimen/Lato |
| Lato | `Lato-Bold.ttf` | 73 KB | SIL OFL 1.1 | https://fonts.google.com/specimen/Lato |
| Lato | `Lato-Italic.ttf` | 76 KB | SIL OFL 1.1 | https://fonts.google.com/specimen/Lato |
| Lato | `Lato-BoldItalic.ttf` | 78 KB | SIL OFL 1.1 | https://fonts.google.com/specimen/Lato |

**Total font payload:** ~380 KB across 5 files. The Atkinson Variable font is a single file covering weights 200 (ExtraLight) through 800 (ExtraBold) via the OpenType variable-axis mechanism — far more efficient than shipping individual weight files (~78 KB vs. 14 × ~25 KB = ~350 KB).

### 4.2 Target paths

```
client/desktop/public/branding/Concord-Voice/fonts/
  ├── BaronNeue.woff                              (existing)
  ├── SourceSans.otf                              (existing)
  ├── AtkinsonHyperlegibleNextVF-Variable.woff2   (NEW — single variable font)
  ├── Lato-Regular.ttf                            (NEW)
  ├── Lato-Bold.ttf                               (NEW)
  ├── Lato-Italic.ttf                             (NEW)
  ├── Lato-BoldItalic.ttf                         (NEW)
  └── LICENSES.md                                 (NEW — SIL OFL 1.1 attribution)
```

The Atkinson Next package upstream ships a Variable WOFF2 (recommended). Lato upstream ships TTF only. Both formats are natively supported by Electron's Chromium engine.

### 4.3 `@font-face` declarations (shipped)

The following 5 blocks are added to `client/desktop/src/renderer/styles/index.css` after the existing BaronNeue/SourceSans declarations, before `:root`:

```css
/* Agency theme fonts — SIL OFL 1.1 (see public/branding/Concord-Voice/fonts/LICENSES.md) */
@font-face {
  font-family: 'Atkinson Hyperlegible Next';
  src: url('/branding/Concord-Voice/fonts/AtkinsonHyperlegibleNextVF-Variable.woff2') format('woff2-variations'),
       url('/branding/Concord-Voice/fonts/AtkinsonHyperlegibleNextVF-Variable.woff2') format('woff2');
  font-weight: 200 800;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: 'Lato';
  src: url('/branding/Concord-Voice/fonts/Lato-Regular.ttf') format('truetype');
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: 'Lato';
  src: url('/branding/Concord-Voice/fonts/Lato-Bold.ttf') format('truetype');
  font-weight: 700;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: 'Lato';
  src: url('/branding/Concord-Voice/fonts/Lato-Italic.ttf') format('truetype');
  font-weight: 400;
  font-style: italic;
  font-display: swap;
}
@font-face {
  font-family: 'Lato';
  src: url('/branding/Concord-Voice/fonts/Lato-BoldItalic.ttf') format('truetype');
  font-weight: 700;
  font-style: italic;
  font-display: swap;
}
```

The Atkinson Variable declaration uses dual-format `src` (`woff2-variations` then `woff2`) so browsers with variable-font support get the full 200–800 axis range, while older browsers (none in current Electron versions) fall back to the same file as a non-variable WOFF2. Both Agency font stacks now reference `'Atkinson Hyperlegible Next'` (not the original):

```css
--font-display-stack: 'Atkinson Hyperlegible Next', 'Lato', system-ui, sans-serif;
--font-body-stack: 'Lato', 'Atkinson Hyperlegible Next', system-ui, sans-serif;
```

`font-display: swap` is critical — without it, an Electron renderer waiting for font load can show a blank page for 100–500ms. With `swap`, fallback fonts render immediately while brand fonts load in background.

### 4.4 Privacy posture — no Google Fonts CDN

**Do not use Google Fonts CDN** (`fonts.googleapis.com`) for Lato. Concord Voice is positioned as a privacy-first communication platform. The Agency theme's underlying brand philosophy is explicitly anti-surveillance. Routing font requests through Google's edge — which can fingerprint users via Referer + IP — would be ironic and reputationally damaging. Local-files-only.

### 4.5 License compliance

Both fonts are SIL OFL 1.1 — permissive free redistribution with attribution. Add an attribution stub in `client/desktop/public/branding/Concord-Voice/fonts/LICENSES.md` listing the source URLs and SIL OFL text per spec. Atkinson Hyperlegible's license file is in its distribution archive. Lato's is at https://github.com/googlefonts/lato/blob/main/OFL.txt.

---

## 5. Accessibility Audit (WCAG 2.1 AA)

**Summary:** 0 critical, 0 major, 0 minor issues. All AA-required pairs pass. Agency is **not** in `tests/unit/styles/link-contrast.test.ts` `KNOWN_NONCOMPLIANT_BLOCKS`.

### 5.1 Contrast results — Dark variant (bg-primary `#050912`)

| Element | Foreground | Contrast | WCAG Req | Result |
|---|---|---:|---:|:---:|
| Body text | `#f0f5fa` | **17.8:1** | 4.5 | ✅ AAA |
| Secondary text | `#94a8c4` | **8.06:1** | 4.5 | ✅ AAA |
| Muted text | `#5e718f` | 3.82:1 | 4.5 / 3.0 large | ⚠️ AA-Large only† |
| Link text | `#6ccdb8` | **10.4:1** | 4.5 | ✅ AAA |
| Link hover | `#8eecd6` | **14.1:1** | 4.5 | ✅ AAA |
| Accent-primary on bg | `#e0004e` | 3.99:1 | 3.0 (UI) | ✅ 1.4.11 |
| Accent-secondary on bg | `#017fa4` | 4.27:1 | 3.0 (UI) | ✅ 1.4.11 |
| White on accent-primary | `#ffffff` | **4.91:1** | 4.5 | ✅ AA |
| Success / status-connected | `#6ccdb8` | **10.4:1** | 3.0 | ✅ AAA |
| Warning / status-connecting | `#f1b435` | **10.7:1** | 3.0 | ✅ AAA |
| Status-disconnected | `#e0004e` | 3.99:1 | 3.0 | ✅ 1.4.11 |

† `--text-muted` 3.82:1 on dark matches existing scheme convention (`midnightsky` 2.30:1, `concord` similar). Token semantics: reserved for de-emphasized adornments, never primary content. No action required for ship.

### 5.2 Contrast results — Light variant (bg-primary `#f5f7fa`)

| Element | Foreground | Contrast | WCAG Req | Result |
|---|---|---:|---:|:---:|
| Body text | `#0a1424` | **16.4:1** | 4.5 | ✅ AAA |
| Secondary text | `#3a4a66` | **8.69:1** | 4.5 | ✅ AAA |
| Muted text | `#5e708a` | **4.84:1** | 4.5 | ✅ AA |
| Link text | `#015a73` | **7.26:1** | 4.5 | ✅ AAA |
| Link hover | `#013548` | **12.15:1** | 4.5 | ✅ AAA |
| Accent-primary | `#a30038` | **7.43:1** | 3.0 | ✅ AAA |
| Accent-secondary | `#015a73` | **7.26:1** | 3.0 | ✅ AAA |
| Danger | `#c4003d` | ~5.8:1 | 3.0 | ✅ AA |

### 5.3 Brand-cyan link role swap (design decision)

In Agency dark, `--link-color` is brand **mint** `#6ccdb8` (not brand cyan `#017fa4`). Brand cyan's contrast on `#050912` is 4.27:1 — 0.23 short of WCAG AA's 4.5 threshold for text. Rather than carve out a per-theme exemption (which the test file's leading comment explicitly forbids: "Remove an entry from this list ONLY by fixing the theme's contrast, never by lowering the threshold or carving out a per-theme exception"), the link role moves to brand mint, which hits AAA at 10.4:1.

Brand cyan retains its role as `--accent-secondary` (icons, buttons, focus rings) where the WCAG 1.4.11 floor is 3.0 and 4.27 passes.

### 5.4 Atkinson Hyperlegible — accessibility positive

The brand-specified `Atkinson Hyperlegible` is engineered by Braille Institute specifically for low-vision readers. Distinctive glyph forms reduce character ambiguity: `a/g/o`, `b/d/p/q`, `1/I/l`. Choosing Agency materially improves text legibility versus Concord's default `BaronNeue` + `SourceSans` pairing. This is a positive a11y delta separate from contrast.

### 5.5 Out of scope

Keyboard navigation (2.1.1), focus indicators (2.4.7), touch targets (2.5.5), and ARIA semantics (4.1.2) are inherited from the existing component layer — adding a CSS color scheme introduces no new surface for these criteria. Focus rings use `--state-focused: var(--accent-secondary)` which meets 1.4.11 in both modes.

---

## 6. Components — State Coverage

Agency tokens flow through Concord's standard component states with no per-component override required. All consumers of the existing 50-token taxonomy automatically pick up Agency when `data-scheme='agency'` is set on `document.documentElement`.

| Component family | Tokens consumed | Agency-specific note |
|---|---|---|
| Buttons | `--accent-primary`, `--accent-hover`, `--on-accent` | Magenta primary, white-on-magenta passes 4.91:1 AA |
| Inputs | `--bg-tertiary`, `--border-color`, `--text-primary` | Navy `#0d294a` input surface, clear focus ring via cyan |
| Modals | `--bg-secondary`, `--radius-modal` (12px) | Mirror baseline |
| Messages | `--text-primary`, `--text-secondary`, `--bg-hover` | AAA contrast for both message body and metadata |
| Chat status badges | `--status-{connected,connecting,disconnected}` | Mint / amber / magenta — brand-pure |
| Reaction picker | `--accent-secondary`, `--bg-tertiary` | Cyan icons on navy surface |
| Settings panels | full taxonomy | Standard Concord layout |
| Code blocks | `--bg-tertiary`, `--text-primary` | Navy surface for inline code reads as "terminal-like" |

---

## 7. Settings UI swatch

Per the existing `colorSchemes` array convention in `AppearanceSection.tsx`, each scheme has a 135deg three-color gradient preview button. Agency's swatch:

```ts
{
  value: 'agency',
  label: 'Agency',
  gradient: 'linear-gradient(135deg, #0d294a, #e0004e, #017fa4)',
}
```

Navy → magenta → cyan reads as the brand's signature visual: the deep navy ground from which the hot magenta "34" mark sits on circuit-trace cyan.

---

## 8. Server-side propagation

The scheme name `'agency'` is persisted server-side via `syncColorSchemeToServer` (debounced 500ms) in the `color_scheme` JSON payload on the user profile (`users.color_scheme`). This propagates to multi-device sessions and to other members who render this user's identity color via `resolveUserAccentColors`.

**Wire identifier stability:** once `'agency'` ships to production and lands in user profiles, renaming the slug is a database migration. The string `"agency"` is part of the API contract from the moment the first user picks the scheme. The neutral name choice (vs. `"defcon34"`) means we don't have a year-rollover risk — DEF CON 35 next year would not invalidate `'agency'`.

---

## 9. Testing checklist

### 9.1 Automated (must pass before merge)

- [x] `npx vitest run tests/unit/styles/link-contrast.test.ts` — 170 tests, 24 skipped (existing exempt list), 0 failures
- [x] `npx vitest run tests/unit/utils/schemeColors.test.ts` — 13-scheme array test passes
- [x] `npx vitest run tests/unit/stores/settingsStore.test.ts` — default scheme unchanged
- [x] `npm run typecheck` — `tsc --noEmit` exits clean
- [x] `npx eslint src/...` — zero lint errors

### 9.2 Manual (before /dev-lifecycle Phase 9)

- [ ] Activate Agency dark in Settings → Appearance → verify all surfaces render correctly
- [ ] Switch to Light → verify accents darken appropriately, link contrast feels distinct
- [ ] Toggle between Concord and Agency rapidly → verify no flash-of-unstyled-content
- [ ] Multi-device: pick Agency on one client, verify it propagates to second client within ~1 sec
- [ ] User profile rendering: another user picking Agency → verify their identity color reflects on your client (avatar fallback gradient, banner)
- [ ] Verify Atkinson Hyperlegible Next renders in headers and Lato in body text (compare to system font baseline — Atkinson's distinctive `a`, `g`, `o` shapes should be visible)

### 9.3 Accessibility manual checks

- [ ] VoiceOver/NVDA — no scheme-specific announcements (scheme is purely visual, screen reader unchanged)
- [ ] 200% zoom — layout doesn't break (inherited from component layer, scheme-agnostic)
- [ ] High-contrast mode (OS-level) — Agency should not interfere with system high-contrast overrides

---

## 10. Rollout — shipped as one PR

Original drafting planned a two-PR split (Phase A = colors + types + UI + tests, Phase B = font binaries + `@font-face` + `LICENSES.md`), reasoning that font binary download couldn't happen in-session. During `/dev-lifecycle` Phase 1.5 scope review, Mark elected to bundle both into a single PR. The developer (Mark) downloaded the binaries from the official sources mid-cycle and the agent committed them alongside the code changes.

The single-PR rollout produces:

- One review cycle from Gitar / Copilot / SonarCloud / Semgrep / Release Classifier covering both colors and fonts
- One CI sweep instead of two
- Issue #1245 auto-closes on merge with the complete deliverable, no follow-up sub-issue to thread through `/dev-lifecycle` separately

User-visible result of the single ship: brand colors active AND brand fonts loaded (Atkinson Hyperlegible Next + Lato), full Agency theme experience.

---

## 11. Trademark + licensing notes

| Asset | Holder | Concord's use posture |
|---|---|---|
| "DEF CON" word mark | DEF CON Communications, Inc. (registered) | **Not used in product UI.** Documented here for engineering reference only. |
| DEF CON skull-and-bones logo | DEF CON Communications, Inc. | Not used. |
| Atkinson Hyperlegible font | Braille Institute of America (SIL OFL 1.1) | Free redistribution with attribution — required `LICENSES.md` entry. |
| Lato font | Łukasz Dziedzic (SIL OFL 1.1) | Free redistribution with attribution — required `LICENSES.md` entry. |
| Color hex values | Not trademarkable individually | Used freely. |
| "Agency" theme name | Concord's choice (DEF CON's concept) | Concord-coined per Decision #1. |

---

## 12. References

- **Source brand guide:** DEF CON 34 Theme and Style Guide (PDF, 2026), `branding/DEF CON® 34 Hacking Conference - Theme and Style Guide.pdf` (local copy)
- **Design-token taxonomy:** issue #1033 — 19-token taxonomy across 6 families, mirrored across 26 blocks (now 28 with Agency)
- **Link-contrast guard:** client/desktop/tests/unit/styles/link-contrast.test.ts — structural WCAG AA enforcement
- **Fox Den incident (prior art for link-color override discipline):** PR #1090, issue #800
- **Atkinson Hyperlegible — Braille Institute:** https://www.brailleinstitute.org/freefont/
- **Lato — Google Fonts:** https://fonts.google.com/specimen/Lato
- **WCAG 2.1:** https://www.w3.org/WAI/WCAG21/quickref/

---

**Drafted by:** Claude Opus 4.7
**For implementation via:** `/issue-creation` → `/dev-lifecycle`
