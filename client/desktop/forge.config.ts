import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { MakerAppImage } from '@reforged/maker-appimage';
import fs from 'fs';

// electron-updater needs app-update.yml in Resources. The file is generated
// by CI (build-desktop.yml) before packaging. Include it only when present
// so local dev builds don't fail.
const extraResource: string[] = [];
if (fs.existsSync('./app-update.yml')) {
  extraResource.push('./app-update.yml');
}

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
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
    osxSign: undefined, // allow unsigned dev builds
    darwinDarkModeSupport: true,
    extendInfo: {
      NSMicrophoneUsageDescription:
        'Concord Voice needs microphone access for voice calls and audio communication.',
      NSCameraUsageDescription:
        'Concord Voice needs camera access for video calls.',
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
