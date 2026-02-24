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
    icon: '../../branding/logos/favicon ICOs/favicon',
    appBundleId: 'com.concord.desktop',
  },
  makers: [
    new MakerSquirrel({
      name: 'Concord',
      setupIcon: '../../branding/logos/favicon ICOs/favicon.ico',
    }),
    new MakerZIP({}, ['darwin']),
    new MakerDeb({
      options: {
        name: 'concord',
        productName: 'Concord',
        genericName: 'Voice Communication',
        categories: ['Network', 'Chat'],
        icon: '../../branding/logos/favicon ICOs/android-chrome-512x512.png',
      },
    }),
    new MakerRpm({
      options: {
        name: 'concord',
        productName: 'Concord',
        genericName: 'Voice Communication',
        categories: ['Network', 'Chat'],
        icon: '../../branding/logos/favicon ICOs/android-chrome-512x512.png',
      },
    }),
  ],
};

export default config;
