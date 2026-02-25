import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    name: 'Concord',
    executableName: 'concord',
    icon: './build/icon',
    appBundleId: 'com.concord.desktop',
  },
  makers: [
    new MakerSquirrel({
      name: 'Concord',
      setupIcon: './build/icon.ico',
    }),
    new MakerZIP({}, ['darwin']),
    new MakerDeb({
      options: {
        name: 'concord',
        bin: 'concord',
        productName: 'Concord',
        genericName: 'Voice Communication',
        categories: ['Network', 'Chat'],
        icon: './build/icon.png',
      },
    }),
    new MakerRpm({
      options: {
        name: 'concord',
        bin: 'concord',
        productName: 'Concord',
        genericName: 'Voice Communication',
        categories: ['Network', 'Chat'],
        icon: './build/icon.png',
      },
    }),
  ],
};

export default config;
