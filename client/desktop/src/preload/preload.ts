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
  quitApp: () => ipcRenderer.invoke('app:quit'),

  // PiP (Picture-in-Picture) windows
  openPipWindow: (opts: { id: string; width?: number; height?: number; title?: string }) =>
    ipcRenderer.invoke('pip:open', opts),
  closePipWindow: (id: string) =>
    ipcRenderer.invoke('pip:close', { id }),
  setPipAlwaysOnTop: (id: string, flag: boolean) =>
    ipcRenderer.invoke('pip:setAlwaysOnTop', { id, flag }),
  onPipClosed: (callback: (id: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { id: string }) => callback(data.id);
    ipcRenderer.on('pip:closed', handler);
    return () => { ipcRenderer.removeListener('pip:closed', handler); };
  },

  // Secure auth token management (safeStorage via main process)
  storeRefreshToken: (data: { refreshToken: string; rememberMe: boolean; apiBase: string }) =>
    ipcRenderer.invoke('auth:storeRefreshToken', data),
  restoreSession: () =>
    ipcRenderer.invoke('auth:restoreSession') as Promise<{ status: string; accessToken?: string }>,
  refreshToken: () =>
    ipcRenderer.invoke('auth:refreshToken') as Promise<{ status: string; accessToken?: string }>,
  clearTokens: () =>
    ipcRenderer.invoke('auth:clearTokens'),
  logout: (data?: { accessToken?: string }) =>
    ipcRenderer.invoke('auth:logout', data),
  getAuthCapabilities: () =>
    ipcRenderer.invoke('auth:getCapabilities') as Promise<{ persistAvailable: boolean }>,
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
  quitApp: () => Promise<void>;
  openPipWindow: (opts: { id: string; width?: number; height?: number; title?: string }) => Promise<void>;
  closePipWindow: (id: string) => Promise<void>;
  setPipAlwaysOnTop: (id: string, flag: boolean) => Promise<void>;
  onPipClosed: (callback: (id: string) => void) => () => void;

  // Secure auth token management
  storeRefreshToken: (data: { refreshToken: string; rememberMe: boolean; apiBase: string }) => Promise<void>;
  restoreSession: () => Promise<{ status: string; accessToken?: string }>;
  refreshToken: () => Promise<{ status: string; accessToken?: string }>;
  clearTokens: () => Promise<void>;
  logout: (data?: { accessToken?: string }) => Promise<void>;
  getAuthCapabilities: () => Promise<{ persistAvailable: boolean }>;
}

declare global {
  interface Window {
    electron: ElectronAPI;
  }
}
