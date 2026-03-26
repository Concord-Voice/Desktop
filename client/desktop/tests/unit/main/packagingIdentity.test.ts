// @vitest-environment node
/**
 * Packaging identity validation tests (#382).
 *
 * These tests read the actual forge config and package.json to verify that
 * all app identity fields are correctly set and consistent across platforms.
 * Prevents regressions where a name change in one place silently creates
 * shared-resource conflicts with other Electron apps.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// ── Load configs ─────────────────────────────────────────────────────────

const desktopRoot = path.resolve(__dirname, '../../../');
const pkgJsonPath = path.join(desktopRoot, 'package.json');
const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));

// Dynamic import for the ES module forge config
async function loadForgeConfig() {
  const mod = await import('../../../forge.config');
  return mod.default;
}

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Extract maker options from a forge config maker instance.
 * electron-forge stores constructor args in `configOrConfigFetcher`.
 * MakerSquirrel stores options directly; Deb/Rpm/AppImage wrap in `options`.
 */
function getMakerOptions(config: any, platform: string) {
  for (const maker of config.makers ?? []) {
    const name = maker.constructor?.name ?? '';
    if (name.toLowerCase().includes(platform.toLowerCase())) {
      const cfg = maker.configOrConfigFetcher ?? {};
      // Deb, Rpm, AppImage use { options: { ... } } wrapper
      return cfg.options ?? cfg;
    }
  }
  return null;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('Packaging Identity (#382)', () => {
  describe('package.json', () => {
    it('has productName set to "ConcordVoice" (spaceless for directory paths)', () => {
      expect(pkgJson.productName).toBe('ConcordVoice');
    });

    it('productName contains no spaces (directory-safe)', () => {
      expect(pkgJson.productName).not.toContain(' ');
    });

    it('has name scoped to @concordvoice/', () => {
      expect(pkgJson.name).toMatch(/^@concordvoice\//);
    });

    it('has author set', () => {
      expect(pkgJson.author).toBeTruthy();
    });

    it('has description containing "Concord"', () => {
      expect(pkgJson.description).toContain('Concord');
    });

    it('does not use generic placeholder names', () => {
      const name = pkgJson.name.toLowerCase();
      const product = (pkgJson.productName ?? '').toLowerCase();
      expect(name).not.toContain('electron');
      expect(name).not.toContain('my-app');
      expect(product).not.toContain('electron');
      expect(product).not.toBe('');
    });
  });

  describe('forge.config.ts — packagerConfig', () => {
    it('has name set to "Concord Voice"', async () => {
      const config = await loadForgeConfig();
      expect(config.packagerConfig?.name).toBe('Concord Voice');
    });

    it('has executableName set to "concord-voice"', async () => {
      const config = await loadForgeConfig();
      expect(config.packagerConfig?.executableName).toBe('concord-voice');
    });

    it('has appBundleId set to com.concordvoice.desktop', async () => {
      const config = await loadForgeConfig();
      expect(config.packagerConfig?.appBundleId).toBe('com.concordvoice.desktop');
    });
  });

  describe('forge.config.ts — MakerSquirrel (Windows)', () => {
    it('has name set to "ConcordVoice" (no spaces — registry safe)', async () => {
      const config = await loadForgeConfig();
      const squirrel = getMakerOptions(config, 'Squirrel');
      expect(squirrel).not.toBeNull();
      expect(squirrel.name).toBe('ConcordVoice');
    });

    it('has setupExe set and containing "ConcordVoice"', async () => {
      const config = await loadForgeConfig();
      const squirrel = getMakerOptions(config, 'Squirrel');
      expect(squirrel.setupExe).toBeTruthy();
      expect(squirrel.setupExe).toContain('ConcordVoice');
    });

    it('setupExe does not use generic names', async () => {
      const config = await loadForgeConfig();
      const squirrel = getMakerOptions(config, 'Squirrel');
      const exe = squirrel.setupExe?.toLowerCase() ?? '';
      expect(exe).not.toBe('setup.exe');
      expect(exe).not.toContain('electron');
    });

    it('has description set', async () => {
      const config = await loadForgeConfig();
      const squirrel = getMakerOptions(config, 'Squirrel');
      expect(squirrel.description).toBeTruthy();
      expect(squirrel.description.length).toBeGreaterThan(10);
    });

    it('has copyright set', async () => {
      const config = await loadForgeConfig();
      const squirrel = getMakerOptions(config, 'Squirrel');
      expect(squirrel.copyright).toBeTruthy();
      expect(squirrel.copyright).toContain('Concord');
    });

    it('has owners set', async () => {
      const config = await loadForgeConfig();
      const squirrel = getMakerOptions(config, 'Squirrel');
      expect(squirrel.owners).toBeTruthy();
    });

    it('name is the spaceless form of packagerConfig.name', async () => {
      const config = await loadForgeConfig();
      const squirrel = getMakerOptions(config, 'Squirrel');
      const expected = config.packagerConfig?.name?.replaceAll(/\s+/g, '');
      expect(squirrel.name).toBe(expected);
    });
  });

  describe('forge.config.ts — MakerDeb (Linux .deb)', () => {
    it('has name matching executableName', async () => {
      const config = await loadForgeConfig();
      const deb = getMakerOptions(config, 'Deb');
      expect(deb).not.toBeNull();
      expect(deb.name).toBe(config.packagerConfig?.executableName);
    });

    it('has bin matching executableName', async () => {
      const config = await loadForgeConfig();
      const deb = getMakerOptions(config, 'Deb');
      expect(deb.bin).toBe(config.packagerConfig?.executableName);
    });

    it('has productName set', async () => {
      const config = await loadForgeConfig();
      const deb = getMakerOptions(config, 'Deb');
      expect(deb.productName).toBe('Concord Voice');
    });
  });

  describe('forge.config.ts — MakerRpm (Linux .rpm)', () => {
    it('has name matching executableName', async () => {
      const config = await loadForgeConfig();
      const rpm = getMakerOptions(config, 'Rpm');
      expect(rpm).not.toBeNull();
      expect(rpm.name).toBe(config.packagerConfig?.executableName);
    });

    it('has bin matching executableName', async () => {
      const config = await loadForgeConfig();
      const rpm = getMakerOptions(config, 'Rpm');
      expect(rpm.bin).toBe(config.packagerConfig?.executableName);
    });

    it('has productName set', async () => {
      const config = await loadForgeConfig();
      const rpm = getMakerOptions(config, 'Rpm');
      expect(rpm.productName).toBe('Concord Voice');
    });
  });

  describe('forge.config.ts — MakerAppImage (Linux AppImage)', () => {
    it('has bin matching executableName', async () => {
      const config = await loadForgeConfig();
      const appImage = getMakerOptions(config, 'AppImage');
      expect(appImage).not.toBeNull();
      expect(appImage.bin).toBe(config.packagerConfig?.executableName);
    });
  });

  describe('cross-platform identity consistency', () => {
    it('all Linux makers use the same bin name', async () => {
      const config = await loadForgeConfig();
      const deb = getMakerOptions(config, 'Deb');
      const rpm = getMakerOptions(config, 'Rpm');
      const appImage = getMakerOptions(config, 'AppImage');
      const bins = [deb?.bin, rpm?.bin, appImage?.bin].filter(Boolean);
      expect(new Set(bins).size).toBe(1);
      expect(bins[0]).toBe('concord-voice');
    });

    it('productName is the spaceless form of packagerConfig.name', async () => {
      const config = await loadForgeConfig();
      expect(pkgJson.productName).toBe(config.packagerConfig?.name?.replaceAll(/\s+/g, ''));
    });

    it('packagerConfig.name contains a space (display name)', async () => {
      const config = await loadForgeConfig();
      expect(config.packagerConfig?.name).toContain(' ');
    });

    it('no maker config contains "electron" or "my-app" in identity fields', async () => {
      const config = await loadForgeConfig();
      for (const maker of config.makers ?? []) {
        const cfg = maker.configOrConfigFetcher ?? {};
        // Deb/Rpm/AppImage nest under options; Squirrel is flat
        const opts = cfg.options ?? cfg;
        const name = (opts.name ?? '').toLowerCase();
        expect(name).not.toContain('my-app');
        // 'electron' in description is OK (e.g. "Electron-based"), but not in name
        expect(name).not.toBe('electron');
      }
    });
  });
});
