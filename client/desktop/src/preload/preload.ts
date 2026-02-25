import { contextBridge, ipcRenderer } from 'electron';

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
// Desktop source info for screen share picker
export interface DesktopSource {
  id: string;
  name: string;
  thumbnail: string; // data URL
  appIcon: string | null; // data URL
}

contextBridge.exposeInMainWorld('electron', {
  // App info
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
  getPlatform: () => ipcRenderer.invoke('app:getPlatform'),

  // Media: screen capture sources for voice/video screen share
  getDesktopSources: () => ipcRenderer.invoke('media:getDesktopSources') as Promise<DesktopSource[]>,

  // Clipboard (navigator.clipboard.writeText is blocked in Electron renderers)
  writeClipboard: (text: string) => ipcRenderer.invoke('clipboard:writeText', text),

  // GPU & hardware acceleration
  getGPUInfo: () => ipcRenderer.invoke('gpu:getInfo') as Promise<{ vendor: string; device: string } | null>,
  getHardwareAcceleration: () => ipcRenderer.invoke('app:getHardwareAcceleration') as Promise<boolean>,
  setHardwareAcceleration: (enabled: boolean) => ipcRenderer.invoke('app:setHardwareAcceleration', enabled),
  relaunchApp: () => ipcRenderer.invoke('app:relaunch'),
});

// Type definitions for the exposed API
export interface ElectronAPI {
  getVersion: () => Promise<string>;
  getPlatform: () => Promise<string>;
  getDesktopSources: () => Promise<DesktopSource[]>;
  writeClipboard: (text: string) => Promise<void>;
  getGPUInfo: () => Promise<{ vendor: string; device: string } | null>;
  getHardwareAcceleration: () => Promise<boolean>;
  setHardwareAcceleration: (enabled: boolean) => Promise<void>;
  relaunchApp: () => Promise<void>;
}

declare global {
  interface Window {
    electron: ElectronAPI;
  }
}
