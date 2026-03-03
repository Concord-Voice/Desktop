/**
 * Static map of preset color scheme names → accent colors.
 * Values extracted from styles/index.css dark-mode scheme definitions.
 *
 * Used to render per-user identity colors (avatar fallback, banner fallback)
 * based on another user's chosen color scheme, without parsing CSS at runtime.
 */

export interface SchemeAccentColors {
  accentPrimary: string;
  accentSecondary: string;
  gradient: string;
}

const SCHEME_ACCENTS: Record<string, [primary: string, secondary: string]> = {
  concord:     ['#fa709a', '#ffe13f'],
  morky:       ['#e63946', '#ff6b35'],
  bardic:      ['#c471ed', '#f64f8e'],
  hacker:      ['#00ff41', '#00ee38'],
  foxden:      ['#ff6d00', '#ff9100'],
  spooky:      ['#ff6a00', '#8b20aa'],
  leviathan:   ['#0ea5e9', '#06b6d4'],
  grassynill:  ['#6b8e23', '#8b7355'],
  cottoncandy: ['#ff6ea8', '#40c8ff'],
  driftwood:   ['#c8a46c', '#a07848'],
  eclipse:     ['#cc0000', '#880000'],
  midnightsky: ['#6d8cff', '#a78bfa'],
};

function buildGradient(primary: string, secondary: string): string {
  return `linear-gradient(135deg, ${primary} 0%, ${secondary} 100%)`;
}

// Pre-build the full SchemeAccentColors objects for each preset
const PRESET_COLORS: Record<string, SchemeAccentColors> = {};
for (const [name, [p, s]] of Object.entries(SCHEME_ACCENTS)) {
  PRESET_COLORS[name] = { accentPrimary: p, accentSecondary: s, gradient: buildGradient(p, s) };
}

/**
 * Resolve a user's server-stored color_scheme JSON into accent colors.
 *
 * @param colorSchemeJson - The raw JSON string from the user profile, or null/undefined.
 * @returns Resolved accent colors, or null if not set / invalid (use global theme fallback).
 */
export function resolveUserAccentColors(
  colorSchemeJson: string | null | undefined,
): SchemeAccentColors | null {
  if (!colorSchemeJson) return null;

  try {
    const parsed = JSON.parse(colorSchemeJson) as {
      scheme?: string;
      accentPrimary?: string;
      accentSecondary?: string;
    };

    if (!parsed.scheme) return null;

    // Custom theme — user provided accent colors
    if (parsed.scheme === 'custom' && parsed.accentPrimary && parsed.accentSecondary) {
      return {
        accentPrimary: parsed.accentPrimary,
        accentSecondary: parsed.accentSecondary,
        gradient: buildGradient(parsed.accentPrimary, parsed.accentSecondary),
      };
    }

    // Preset scheme — look up from static map
    return PRESET_COLORS[parsed.scheme] ?? null;
  } catch {
    return null;
  }
}
