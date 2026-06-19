import { describe, it, expect } from 'vitest';
import {
  resolveEffectiveFont,
  themeBundledFontFor,
  RESOLVER_CONFIG,
} from '@/renderer/utils/effectiveFont';

const userWins = { themeVsUser: 'user-wins' as const };
const themeWins = { themeVsUser: 'theme-wins' as const };

describe('resolveEffectiveFont', () => {
  it('dyslexic overrides everything (both configs)', () => {
    for (const cfg of [userWins, themeWins]) {
      const r = resolveEffectiveFont(
        { dyslexicSupport: true, appFont: 'inter', themeBundledFont: 'atkinson' },
        cfg
      );
      expect(r).toEqual({ effective: 'opendyslexic', pickerLocked: true, lockReason: 'dyslexic' });
    }
  });

  it('user-wins: explicit pick overrides theme font', () => {
    const r = resolveEffectiveFont(
      { dyslexicSupport: false, appFont: 'inter', themeBundledFont: 'atkinson' },
      userWins
    );
    expect(r).toEqual({ effective: 'inter', pickerLocked: false, lockReason: null });
  });

  it('user-wins: no explicit pick keeps theme font (locked)', () => {
    const r = resolveEffectiveFont(
      { dyslexicSupport: false, appFont: 'default', themeBundledFont: 'atkinson' },
      userWins
    );
    expect(r).toEqual({ effective: 'atkinson', pickerLocked: true, lockReason: 'theme' });
  });

  it('theme-wins: theme font locks even over an explicit pick', () => {
    const r = resolveEffectiveFont(
      { dyslexicSupport: false, appFont: 'inter', themeBundledFont: 'atkinson' },
      themeWins
    );
    expect(r).toEqual({ effective: 'atkinson', pickerLocked: true, lockReason: 'theme' });
  });

  it('no theme font: explicit pick applies, unlocked', () => {
    const r = resolveEffectiveFont(
      { dyslexicSupport: false, appFont: 'lexend', themeBundledFont: null },
      userWins
    );
    expect(r).toEqual({ effective: 'lexend', pickerLocked: false, lockReason: null });
  });

  it('no theme font, no pick: app default', () => {
    const r = resolveEffectiveFont(
      { dyslexicSupport: false, appFont: 'default', themeBundledFont: null },
      userWins
    );
    expect(r).toEqual({ effective: 'default', pickerLocked: false, lockReason: null });
  });

  it('ships C1 config as user-wins', () => {
    expect(RESOLVER_CONFIG.themeVsUser).toBe('user-wins');
  });

  it('themeBundledFontFor is a null stub in C1 (seam for #1643)', () => {
    expect(themeBundledFontFor('agency')).toBeNull();
    expect(themeBundledFontFor('concord')).toBeNull();
  });
});
