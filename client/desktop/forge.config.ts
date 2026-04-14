import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { MakerAppImage } from '@reforged/maker-appimage';
import fs from 'fs';

// macOS signing & notarization — active only when CI provides all required env vars.
// Local developer builds without these env vars produce unsigned .app bundles.
//
// Per the Electron Forge signing docs (https://www.electronforge.io/guides/
// code-signing/code-signing-macos), `osxSign: {}` — empty object — is the
// recommended default. @electron/osx-sign ships a tested-in-the-wild set of
// entitlements (https://github.com/electron/osx-sign/tree/main/entitlements)
// and per-file signing logic for Electron's nested helper apps. We previously
// tried overriding these defaults via `optionsForFile` + a custom entitlements
// plist and hit a silent codesign hang during outer-bundle signing; trusting
// the defaults resolves it (see issue #403 debugging history).
//
// Forge auto-detects the signing identity by scanning the keychain for a
// `Developer ID Application` cert, so the identity string does not need to
// be hardcoded as long as exactly one such cert is imported.
const macSigning: Pick<
  NonNullable<ForgeConfig['packagerConfig']>,
  'osxSign' | 'osxNotarize'
> = process.env.APPLE_ID && process.env.APPLE_ID_PASSWORD && process.env.APPLE_TEAM_ID
  ? {
      osxSign: {},
      osxNotarize: {
        appleId: process.env.APPLE_ID,
        appleIdPassword: process.env.APPLE_ID_PASSWORD,
        teamId: process.env.APPLE_TEAM_ID,
      },
    }
  : {};

// electron-updater needs app-update.yml in Resources. The file is generated
// by CI (build-desktop.yml) before packaging. Include it only when present
// so local dev builds don't fail.
const extraResource: string[] = [];
if (fs.existsSync('./app-update.yml')) {
  extraResource.push('./app-update.yml');
}

const config: ForgeConfig = {
  packagerConfig: {
    asar: {
      // Exclude source maps from the packaged ASAR archive. Source maps are
      // uploaded to Sentry in CI for server-side stack trace resolution;
      // they must NOT ship to end users (exposes full source code).
      unpackDir: undefined,
    },
    ignore: [/\.map$/],
    name: 'Concord Voice',
    executableName: 'concord-voice',
    icon: './build/icon',
    appBundleId: 'com.concordvoice.desktop',
    appCopyright: 'Copyright © 2026 Concord Voice Team',
    appCategoryType: 'public.app-category.social-networking',
    win32metadata: {
      CompanyName: 'Concord Voice Team',
      FileDescription: 'Concord Voice Desktop Client',
      ProductName: 'Concord Voice',
    },
    extraResource,
    ...macSigning,
    darwinDarkModeSupport: true,
    extendInfo: {
      NSMicrophoneUsageDescription:
        'Concord Voice needs microphone access for voice calls and audio communication.',
      NSCameraUsageDescription: 'Concord Voice needs camera access for video calls.',
    },
  },
  makers: [
    new MakerSquirrel({
      name: 'ConcordVoice',
      setupExe: 'ConcordVoiceSetup.exe',
      setupIcon: './build/icon.ico',
      loadingGif: './build/splash.gif',
      iconUrl: 'https://concordvoice.com/icon.ico',
      description: 'Concord Voice Desktop Client - Privacy-first voice communication',
      copyright: 'Copyright © 2026 Concord Voice Team. All rights reserved.',
      owners: 'Concord Voice Team',
    }),
    new MakerZIP({}, ['darwin']),
    new MakerDeb({
      options: {
        name: 'concord-voice',
        bin: 'concord-voice',
        productName: 'Concord Voice',
        genericName: 'Voice Communication',
        description: 'Concord Voice Desktop Client',
        productDescription: 'Privacy-first voice communication platform.',
        maintainer: 'Concord Voice Team <support@concordvoice.com>',
        homepage: 'https://concordvoice.com',
        section: 'net',
        categories: ['Network', 'Chat'],
        icon: './build/icon.png',
      },
    }),
    new MakerRpm({
      options: {
        name: 'concord-voice',
        bin: 'concord-voice',
        productName: 'Concord Voice',
        genericName: 'Voice Communication',
        description: 'Concord Voice Desktop Client',
        productDescription: 'Privacy-first voice communication platform.',
        homepage: 'https://concordvoice.com',
        license: 'BUSL-1.1',
        group: 'Applications/Communications',
        categories: ['Network', 'Chat'],
        icon: './build/icon.png',
      },
    }),
    new MakerAppImage({
      options: {
        bin: 'concord-voice',
        productName: 'Concord Voice',
        categories: ['Network', 'Chat'],
        icon: './build/icon.png',
      },
    }),
  ],
};

export default config;
