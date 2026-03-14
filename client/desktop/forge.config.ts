import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { MakerAppImage } from '@reforged/maker-appimage';

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    name: 'Concord Voice',
    executableName: 'concord-voice',
    icon: './build/icon',
    appBundleId: 'com.concordvoice.desktop',
  },
  makers: [
    new MakerSquirrel({
      name: 'ConcordVoice',
      setupIcon: './build/icon.ico',
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
        categories: ['Network', 'Chat'],
        icon: './build/icon.png',
      },
    }),
  ],
};

export default config;
