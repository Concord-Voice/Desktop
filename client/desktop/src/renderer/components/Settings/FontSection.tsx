import React from 'react';
import type { AppearanceSettings } from '../../stores/settingsStore';
import { useDraftAppearance, setDraftAppearanceSetting } from '../../hooks/useDraftSettings';
import {
  resolveEffectiveFont,
  themeBundledFontFor,
  RESOLVER_CONFIG,
} from '../../utils/effectiveFont';
import CollapsibleSection from './CollapsibleSection';
import './FontSection.css';

// Self-hosted, license-cleared application fonts (see public/branding/Concord-Voice/
// fonts/LICENSES.md). `family` drives only the per-option live PREVIEW; selecting an
// option writes `appFont` to the draft store, and the effective-font resolver
// (utils/effectiveFont.ts) applies the result via the `data-appfont` attribute.
// 'default' previews the base body face (SourceSans). The picker changes BODY text;
// brand/heading surfaces keep their display face.
const FONT_OPTIONS: { id: AppearanceSettings['appFont']; label: string; family: string }[] = [
  { id: 'default', label: 'Concord Voice Default', family: "'SourceSans', sans-serif" },
  { id: 'system', label: 'System Default', family: 'system-ui, sans-serif' },
  { id: 'opendyslexic', label: 'OpenDyslexic', family: "'OpenDyslexic', sans-serif" },
  { id: 'inter', label: 'Inter', family: "'Inter', sans-serif" },
  { id: 'lexend', label: 'Lexend', family: "'Lexend', sans-serif" },
  { id: 'lato', label: 'Lato', family: "'Lato', sans-serif" },
  {
    id: 'atkinson',
    label: 'Atkinson Hyperlegible Next',
    family: "'Atkinson Hyperlegible Next', sans-serif",
  },
];

const FontSection: React.FC = () => {
  const appearance = useDraftAppearance();
  const { appFont, dyslexicSupport, colorScheme } = appearance;

  // Consume the pure resolver over DRAFT appearance (live preview) — the same call
  // the settingsStore subscriber makes over committed state. #1643 renders the SOFT
  // theme-lock (lockReason==='theme'); #1644 extends `activeId` for the dyslexic
  // HARD lock (lockReason==='dyslexic'). See spec §4.2.
  const themeBundledFont = themeBundledFontFor(colorScheme);
  const { effective, lockReason } = resolveEffectiveFont(
    { dyslexicSupport, appFont, themeBundledFont },
    RESOLVER_CONFIG
  );
  // Under user-wins the theme only "locks" when the user hasn't picked; the active
  // option is then the theme font. Otherwise it tracks the user's appFont. Options
  // stay interactive so a pick overrides (soft lock — spec §3 D4).
  const activeId = lockReason === 'theme' ? effective : appFont;

  return (
    <CollapsibleSection id="section-fonts" title="Application Font">
      <p className="settings-section-description">
        Choose the font used for body text across the app — including OpenDyslexic, designed to
        improve readability for people with dyslexia.
      </p>
      {/* <fieldset>/<legend> give native group semantics (the accessible name for
          the choice set) without an ARIA role — satisfies S6819 while restoring the
          grouping the design called for. The legend is visually hidden (the section
          heading already shows "Application Font"). */}
      <fieldset className="font-option-list">
        <legend className="font-option-legend">Application font</legend>
        {FONT_OPTIONS.map((f) => (
          <button
            key={f.id}
            type="button"
            className={`font-option ${activeId === f.id ? 'selected' : ''}`}
            aria-pressed={activeId === f.id}
            onClick={() => setDraftAppearanceSetting('appFont', f.id)}
          >
            <span className="font-option-label">
              {f.label}
              {themeBundledFont === f.id && (
                <span className="font-option-theme-badge">Provided by the active theme</span>
              )}
            </span>
            <span
              className="font-option-sample"
              style={{ fontFamily: f.family }}
              aria-hidden="true"
            >
              The quick brown fox jumps over the lazy dog
            </span>
          </button>
        ))}
      </fieldset>
    </CollapsibleSection>
  );
};

export default FontSection;
