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

// ── Constants ────────────────────────────────────────────────────────────

const EXPECTED_DISPLAY_NAME = 'Concord Voice';

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
    it('has productName set to "Concord Voice" (display name with space)', () => {
      expect(pkgJson.productName).toBe(EXPECTED_DISPLAY_NAME);
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
      expect(config.packagerConfig?.name).toBe(EXPECTED_DISPLAY_NAME);
    });

    it('has executableName set to "Concord Voice" (matches display name)', async () => {
      const config = await loadForgeConfig();
      expect(config.packagerConfig?.executableName).toBe(EXPECTED_DISPLAY_NAME);
    });

    it('has appBundleId set to com.concordvoice.desktop', async () => {
      const config = await loadForgeConfig();
      expect(config.packagerConfig?.appBundleId).toBe('com.concordvoice.desktop');
    });

    it('has appCopyright set and containing "Concord"', async () => {
      const config = await loadForgeConfig();
      expect(config.packagerConfig?.appCopyright).toBeTruthy();
      expect(config.packagerConfig?.appCopyright).toContain('Concord');
    });

    it('has appCategoryType set to a macOS UTI category', async () => {
      const config = await loadForgeConfig();
      expect(config.packagerConfig?.appCategoryType).toMatch(/^public\.app-category\./);
    });

    it('has win32metadata.CompanyName set', async () => {
      const config = await loadForgeConfig();
      expect(config.packagerConfig?.win32metadata?.CompanyName).toBeTruthy();
    });

    it('has win32metadata.FileDescription set', async () => {
      const config = await loadForgeConfig();
      expect(config.packagerConfig?.win32metadata?.FileDescription).toBeTruthy();
    });

    it('has win32metadata.ProductName set to "Concord Voice"', async () => {
      const config = await loadForgeConfig();
      expect(config.packagerConfig?.win32metadata?.ProductName).toBe(EXPECTED_DISPLAY_NAME);
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

    it('has loadingGif set for branded installer splash', async () => {
      const config = await loadForgeConfig();
      const squirrel = getMakerOptions(config, 'Squirrel');
      expect(squirrel.loadingGif).toBeTruthy();
    });

    it('has iconUrl set to HTTPS URL', async () => {
      const config = await loadForgeConfig();
      const squirrel = getMakerOptions(config, 'Squirrel');
      expect(squirrel.iconUrl).toBeTruthy();
      expect(squirrel.iconUrl).toMatch(/^https:\/\//);
    });

    it('name is the spaceless form of packagerConfig.name', async () => {
      const config = await loadForgeConfig();
      const squirrel = getMakerOptions(config, 'Squirrel');
      const expected = config.packagerConfig?.name?.replaceAll(/\s+/g, '');
      expect(squirrel.name).toBe(expected);
    });
  });

  describe('forge.config.ts — MakerDeb (Linux .deb)', () => {
    // NOTE: Linux package conventions require lowercase, no-space binary names
    // (debian-policy §5.6.7). The display name (executableName) carries spaces
    // for macOS/Windows; Linux maker bin/name use the kebab-case form
    // 'concord-voice'. The intentional asymmetry is verified in the
    // 'cross-platform identity consistency' block below.
    it('has name set to "concord-voice" (Linux kebab-case convention)', async () => {
      const config = await loadForgeConfig();
      const deb = getMakerOptions(config, 'Deb');
      expect(deb).not.toBeNull();
      expect(deb.name).toBe('concord-voice');
    });

    it('has bin set to "concord-voice" (Linux kebab-case convention)', async () => {
      const config = await loadForgeConfig();
      const deb = getMakerOptions(config, 'Deb');
      expect(deb.bin).toBe('concord-voice');
    });

    it('has productName set', async () => {
      const config = await loadForgeConfig();
      const deb = getMakerOptions(config, 'Deb');
      expect(deb.productName).toBe(EXPECTED_DISPLAY_NAME);
    });

    it('has maintainer set with email', async () => {
      const config = await loadForgeConfig();
      const deb = getMakerOptions(config, 'Deb');
      expect(deb.maintainer).toBeTruthy();
      expect(deb.maintainer).toContain('@');
    });

    it('has homepage set to HTTPS URL', async () => {
      const config = await loadForgeConfig();
      const deb = getMakerOptions(config, 'Deb');
      expect(deb.homepage).toMatch(/^https:\/\//);
    });

    it('has description set', async () => {
      const config = await loadForgeConfig();
      const deb = getMakerOptions(config, 'Deb');
      expect(deb.description).toBeTruthy();
    });

    it('has section set', async () => {
      const config = await loadForgeConfig();
      const deb = getMakerOptions(config, 'Deb');
      expect(deb.section).toBeTruthy();
    });
  });

  describe('forge.config.ts — MakerRpm (Linux .rpm)', () => {
    // Same Linux kebab-case convention as Deb — see comment in MakerDeb block.
    it('has name set to "concord-voice" (Linux kebab-case convention)', async () => {
      const config = await loadForgeConfig();
      const rpm = getMakerOptions(config, 'Rpm');
      expect(rpm).not.toBeNull();
      expect(rpm.name).toBe('concord-voice');
    });

    it('has bin set to "concord-voice" (Linux kebab-case convention)', async () => {
      const config = await loadForgeConfig();
      const rpm = getMakerOptions(config, 'Rpm');
      expect(rpm.bin).toBe('concord-voice');
    });

    it('has productName set', async () => {
      const config = await loadForgeConfig();
      const rpm = getMakerOptions(config, 'Rpm');
      expect(rpm.productName).toBe(EXPECTED_DISPLAY_NAME);
    });

    it('has homepage set to HTTPS URL', async () => {
      const config = await loadForgeConfig();
      const rpm = getMakerOptions(config, 'Rpm');
      expect(rpm.homepage).toMatch(/^https:\/\//);
    });

    it('has license set to BUSL-1.1', async () => {
      const config = await loadForgeConfig();
      const rpm = getMakerOptions(config, 'Rpm');
      expect(rpm.license).toBe('BUSL-1.1');
    });

    it('has description set', async () => {
      const config = await loadForgeConfig();
      const rpm = getMakerOptions(config, 'Rpm');
      expect(rpm.description).toBeTruthy();
    });

    it('has group set', async () => {
      const config = await loadForgeConfig();
      const rpm = getMakerOptions(config, 'Rpm');
      expect(rpm.group).toBeTruthy();
    });
  });

  describe('forge.config.ts — MakerAppImage (Linux AppImage)', () => {
    // Same Linux kebab-case convention as Deb/Rpm — see comment in MakerDeb block.
    it('has bin set to "concord-voice" (Linux kebab-case convention)', async () => {
      const config = await loadForgeConfig();
      const appImage = getMakerOptions(config, 'AppImage');
      expect(appImage).not.toBeNull();
      expect(appImage.bin).toBe('concord-voice');
    });

    it('has productName set', async () => {
      const config = await loadForgeConfig();
      const appImage = getMakerOptions(config, 'AppImage');
      expect(appImage.productName).toBe(EXPECTED_DISPLAY_NAME);
    });
  });

  describe('icon files', () => {
    it('icon.ico exists (Windows)', () => {
      expect(fs.existsSync(path.join(desktopRoot, 'build', 'icon.ico'))).toBe(true);
    });

    it('icon.icns exists (macOS)', () => {
      expect(fs.existsSync(path.join(desktopRoot, 'build', 'icon.icns'))).toBe(true);
    });

    it('icon.png exists (Linux)', () => {
      expect(fs.existsSync(path.join(desktopRoot, 'build', 'icon.png'))).toBe(true);
    });

    it('splash.gif exists (Windows installer splash)', () => {
      expect(fs.existsSync(path.join(desktopRoot, 'build', 'splash.gif'))).toBe(true);
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

    it('productName matches packagerConfig.name (display name consistency)', async () => {
      const config = await loadForgeConfig();
      expect(pkgJson.productName).toBe(config.packagerConfig?.name);
    });

    it('packagerConfig.name contains a space (display name)', async () => {
      const config = await loadForgeConfig();
      expect(config.packagerConfig?.name).toContain(' ');
    });

    it('Linux maker bin intentionally diverges from packagerConfig.executableName (asymmetry guard)', async () => {
      // Locks in the deliberate platform asymmetry: macOS/Windows use the display
      // name ("Concord Voice"); Linux maker bins use kebab-case ("concord-voice")
      // per debian-policy §5.6.7. A future refactor that re-collapses these would
      // silently pass the literal-value assertions in the Deb/Rpm/AppImage blocks
      // without this guard.
      const config = await loadForgeConfig();
      const deb = getMakerOptions(config, 'Deb');
      const rpm = getMakerOptions(config, 'Rpm');
      const appImage = getMakerOptions(config, 'AppImage');
      expect(deb.bin).not.toBe(config.packagerConfig?.executableName);
      expect(rpm.bin).not.toBe(config.packagerConfig?.executableName);
      expect(appImage.bin).not.toBe(config.packagerConfig?.executableName);
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
