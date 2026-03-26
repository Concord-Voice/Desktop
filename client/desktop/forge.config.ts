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
    extraResource,
  },
  makers: [
    new MakerSquirrel({
      name: 'ConcordVoice',
      setupExe: 'ConcordVoiceSetup.exe',
      setupIcon: './build/icon.ico',
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
        categories: ['Network', 'Chat'],
        icon: './build/icon.png',
      },
    }),
    new MakerAppImage({
      options: {
        bin: 'concord-voice',
        categories: ['Network', 'Chat'],
        icon: './build/icon.png',
      },
    }),
  ],
};

export default config;
