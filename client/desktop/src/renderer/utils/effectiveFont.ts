// Pure effective-font resolver — the single source of truth for "which font applies".
// No DOM, no store imports: unit-testable in isolation. See
// internal-reference §3.1.

export type AppFontId =
  | 'default' // Concord Voice Default (brand) — ALSO the "no explicit pick" sentinel
  | 'system' // OS UI font stack
  | 'opendyslexic'
  | 'inter'
  | 'lexend'
  | 'lato' // already bundled (Agency body)
  | 'atkinson'; // already bundled — CSS family 'Atkinson Hyperlegible Next'

export const DYSLEXIA_FONT: AppFontId = 'opendyslexic';
export const APP_DEFAULT_FONT: AppFontId = 'default';

export interface FontResolverConfig {
  // Q1: does an explicit user pick override a font-bundling theme?
  //   'theme-wins' → theme locks its font; 'user-wins' → explicit pick overrides.
  themeVsUser: 'theme-wins' | 'user-wins';
}

export interface FontResolverInput {
  dyslexicSupport: boolean;
  appFont: AppFontId; // 'default' means "no explicit pick"
  themeBundledFont: AppFontId | null; // C1: always null; #1643 fills it via SCHEME_FONTS
}

export interface FontResolution {
  effective: AppFontId;
  pickerLocked: boolean; // #1644 greys the Appearance picker when true
  lockReason: 'dyslexic' | 'theme' | null;
}

export function resolveEffectiveFont(
  input: FontResolverInput,
  cfg: FontResolverConfig
): FontResolution {
  // Layer 1 — Dyslexic Support: authoritative, beats everything.
  if (input.dyslexicSupport) {
    return { effective: DYSLEXIA_FONT, pickerLocked: true, lockReason: 'dyslexic' };
  }

  const userPicked = input.appFont !== APP_DEFAULT_FONT;

  // Layers 2 + 3 — theme vs user pick. The only place Q1 changes behavior.
  if (input.themeBundledFont) {
    if (cfg.themeVsUser === 'user-wins' && userPicked) {
      return { effective: input.appFont, pickerLocked: false, lockReason: null };
    }
    // 'theme-wins', or the user made no explicit pick: theme locks its font.
    return { effective: input.themeBundledFont, pickerLocked: true, lockReason: 'theme' };
  }

  // Layer 3 — user pick (no bundling theme active).
  if (userPicked) {
    return { effective: input.appFont, pickerLocked: false, lockReason: null };
  }

  // Layer 4 — app default.
  return { effective: APP_DEFAULT_FONT, pickerLocked: false, lockReason: null };
}

/**
 * #1643 seam. Returns the active scheme's bundled font id, or null.
 * C1 ships the null stub; #1643 replaces the body with the SCHEME_FONTS lookup
 * (Agency → 'lato'). Kept a real function (not an inlined null) so #1643's diff is
 * one function body, not a subscriber rewire.
 */
export function themeBundledFontFor(_colorScheme: string): AppFontId | null {
  return null;
}

/** The shipped C1 configuration: an explicit user pick wins over a theme font (Q1). */
export const RESOLVER_CONFIG: FontResolverConfig = { themeVsUser: 'user-wins' };
