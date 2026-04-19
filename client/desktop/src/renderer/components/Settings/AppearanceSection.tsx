import React from 'react';
import type { AppearanceSettings, CustomColors } from '../../stores/settingsStore';
import { useDraftAppearance, setDraftAppearanceSetting } from '../../hooks/useDraftSettings';
import { isValidHex } from '../../utils/colorUtils';
import ToggleSwitch from './ToggleSwitch';
import CollapsibleSection from './CollapsibleSection';

const AppearanceSection: React.FC = () => {
  const appearance = useDraftAppearance();

  const colorSchemes: {
    value: AppearanceSettings['colorScheme'];
    label: string;
    gradient: string;
  }[] = [
    {
      value: 'concord',
      label: 'Concord Voice',
      gradient: 'linear-gradient(135deg, #0d0821, #fa709a, #ffe13f)',
    },
    {
      value: 'eclipse',
      label: 'Eclipse',
      gradient: 'linear-gradient(135deg, #000000, #cc0000, #880000)',
    },
    {
      value: 'morky',
      label: '9th Circle',
      gradient: 'linear-gradient(135deg, #0a0a0a, #e63946, #ff6b35)',
    },
    {
      value: 'foxden',
      label: 'Fox Den',
      gradient: 'linear-gradient(135deg, #1a0e02, #ff6d00, #ff9100)',
    },
    {
      value: 'spooky',
      label: 'Spooky',
      gradient: 'linear-gradient(135deg, #0a0a0a, #ff6a00, #8b20aa)',
    },
    {
      value: 'driftwood',
      label: 'Driftwood',
      gradient: 'linear-gradient(135deg, #120e0a, #c8a46c, #a07848)',
    },
    {
      value: 'grassynill',
      label: 'Grassy Nill',
      gradient: 'linear-gradient(135deg, #0c0e08, #6b8e23, #8b7355)',
    },
    {
      value: 'hacker',
      label: 'Hacker',
      gradient: 'linear-gradient(135deg, #000000, #00ff41, #00ee38)',
    },
    {
      value: 'leviathan',
      label: 'Leviathan',
      gradient: 'linear-gradient(135deg, #020c14, #0ea5e9, #06b6d4)',
    },
    {
      value: 'midnightsky',
      label: 'Midnight Sky',
      gradient: 'linear-gradient(135deg, #060a18, #6d8cff, #a78bfa)',
    },
    {
      value: 'bardic',
      label: 'Bardic',
      gradient: 'linear-gradient(135deg, #120a1e, #c471ed, #f64f8e)',
    },
    {
      value: 'cottoncandy',
      label: 'Cotton Candy',
      gradient: 'linear-gradient(135deg, #0a0810, #ff6ea8, #40c8ff)',
    },
  ];

  const themes: { value: AppearanceSettings['theme']; label: string; icon: React.ReactNode }[] = [
    {
      value: 'dark',
      label: 'Dark',
      icon: (
        <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
          <path
            d="M21 12.79A9 9 0 119.21 1a7 7 0 0011.79 11.79z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ),
    },
    {
      value: 'light',
      label: 'Light',
      icon: (
        <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
          <circle cx="11" cy="11" r="5" stroke="currentColor" strokeWidth="1.5" />
          <path
            d="M11 1v2M11 19v2M3.22 3.22l1.42 1.42M17.36 17.36l1.42 1.42M1 11h2M19 11h2M3.22 18.78l1.42-1.42M17.36 4.64l1.42-1.42"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      ),
    },
    {
      value: 'system',
      label: 'System',
      icon: (
        <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
          <rect x="2" y="3" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.5" />
          <path d="M8 21h6M11 17v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      ),
    },
  ];

  const fontSizes: { value: AppearanceSettings['fontSize']; label: string }[] = [
    { value: 'small', label: 'Small' },
    { value: 'default', label: 'Default' },
    { value: 'large', label: 'Large' },
  ];

  return (
    <>
      <CollapsibleSection id="section-color-scheme" title="Color Scheme">
        <p className="settings-section-description">Pick a color palette for the entire app.</p>
        <span className="color-scheme-active-label">
          {appearance.colorScheme === 'custom'
            ? 'Custom'
            : colorSchemes.find((cs) => cs.value === appearance.colorScheme)?.label}
        </span>
        <div className="color-scheme-grid">
          {colorSchemes.map((cs) => (
            <button
              key={cs.value}
              className={`color-scheme-circle ${appearance.colorScheme === cs.value ? 'selected' : ''}`}
              style={{ background: cs.gradient }}
              onClick={() => setDraftAppearanceSetting('colorScheme', cs.value)}
              title={cs.label}
            />
          ))}
          {/* Custom theme circle */}
          <button
            className={`color-scheme-circle custom-add ${appearance.colorScheme === 'custom' ? 'selected' : ''}`}
            style={
              appearance.customColors
                ? {
                    background: `linear-gradient(135deg, ${appearance.customColors.background}, ${appearance.customColors.accentPrimary}, ${appearance.customColors.accentSecondary})`,
                  }
                : undefined
            }
            onClick={() => {
              if (appearance.customColors) {
                setDraftAppearanceSetting('customColors', appearance.customColors);
                setDraftAppearanceSetting('colorScheme', 'custom');
              } else {
                const defaults: CustomColors = {
                  background: '#0d0821',
                  accentPrimary: '#fa709a',
                  accentSecondary: '#ffe13f',
                };
                setDraftAppearanceSetting('customColors', defaults);
                setDraftAppearanceSetting('colorScheme', 'custom');
              }
            }}
            title="Custom"
          >
            {!appearance.customColors && (
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path
                  d="M8 2v12M2 8h12"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            )}
          </button>
        </div>

        {/* Custom theme color picker panel */}
        {appearance.colorScheme === 'custom' && appearance.customColors && (
          <div className="custom-theme-picker">
            {(() => {
              // Capture narrowed value so the map callbacks can reference it
              // without TypeScript losing the narrowing across the closure.
              const customColors = appearance.customColors;
              return [
                { key: 'background' as const, label: 'Background' },
                { key: 'accentPrimary' as const, label: 'Primary Accent' },
                { key: 'accentSecondary' as const, label: 'Secondary Accent' },
              ].map(({ key, label }) => (
                <div key={key} className="custom-theme-picker-row">
                  <label htmlFor={`custom-theme-${key}`} className="custom-theme-picker-label">
                    {label}
                  </label>
                  <div className="custom-theme-picker-input-group">
                    <input
                      id={`custom-theme-${key}`}
                      type="color"
                      value={customColors[key]}
                      onChange={(e) =>
                        setDraftAppearanceSetting('customColors', {
                          ...customColors,
                          [key]: e.target.value,
                        })
                      }
                      className="custom-theme-color-input"
                    />
                    <input
                      type="text"
                      value={customColors[key]}
                      onChange={(e) => {
                        const val = e.target.value;
                        if (isValidHex(val)) {
                          setDraftAppearanceSetting('customColors', {
                            ...customColors,
                            [key]: val,
                          });
                        }
                      }}
                      className="custom-theme-hex-input"
                      maxLength={7}
                      spellCheck={false}
                    />
                  </div>
                </div>
              ));
            })()}
          </div>
        )}
      </CollapsibleSection>

      <CollapsibleSection id="section-theme" title="Theme">
        <p className="settings-section-description">
          Choose how Concord Voice looks to you. Select a theme or match your system settings.
        </p>
        <div className="theme-selector">
          {themes.map((t) => (
            <button
              key={t.value}
              className={`theme-option ${appearance.theme === t.value ? 'selected' : ''}`}
              onClick={() => setDraftAppearanceSetting('theme', t.value)}
            >
              <div className="theme-option-icon">{t.icon}</div>
              <span className="theme-option-label">{t.label}</span>
            </button>
          ))}
        </div>
      </CollapsibleSection>

      <CollapsibleSection id="section-display" title="Display">
        <div className="form-group">
          <span className="form-label">Font Size</span>
          <div className="font-size-selector">
            {fontSizes.map((fs) => (
              <button
                key={fs.value}
                className={`font-size-option ${fs.value} ${appearance.fontSize === fs.value ? 'selected' : ''}`}
                onClick={() => setDraftAppearanceSetting('fontSize', fs.value)}
              >
                {fs.label}
              </button>
            ))}
          </div>
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">Compact Mode</span>
            <span className="settings-row-hint">
              {appearance.compactMode
                ? 'Enabled. Padding and spacing are reduced throughout the interface, fitting more content on screen.'
                : 'Disabled. Standard padding and spacing for a comfortable, spacious layout.'}
            </span>
          </div>
          <ToggleSwitch
            checked={appearance.compactMode}
            onChange={(v) => setDraftAppearanceSetting('compactMode', v)}
          />
        </div>

        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-row-label">Reduce Animations</span>
            <span className="settings-row-hint">
              {appearance.reduceAnimations
                ? 'Enabled. Motion and transitions are minimized throughout the interface for a snappier experience.'
                : 'Disabled. Standard animations and transitions are used for a fluid interface.'}
            </span>
          </div>
          <ToggleSwitch
            checked={appearance.reduceAnimations}
            onChange={(v) => setDraftAppearanceSetting('reduceAnimations', v)}
          />
        </div>
      </CollapsibleSection>
    </>
  );
};

export default AppearanceSection;
