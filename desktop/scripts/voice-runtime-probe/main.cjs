const { app, BrowserWindow } = require('electron');

// This is a test-only shell, with the same renderer isolation requirements as the app.
if (app.commandLine.hasSwitch('no-sandbox') || app.commandLine.hasSwitch('disable-setuid-sandbox')) {
  throw new Error('The voice runtime probe requires Chromium sandboxing');
}
app.enableSandbox();
// macOS marks a fully covered window as occluded and backgrounds its renderer,
// which can stop the hidden peer's canvas capture mid-call; backgroundThrottling
// alone does not prevent that. Keep both renderers foreground-equivalent.
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
const windows = [];
globalThis.voiceProbeLifecycle = { rendererCrashes: 0, navigationFailures: 0 };
app.whenReady().then(() => {
  for (const [index, peer] of ['a', 'b'].entries()) {
    // Side by side, never stacked: a stacked twin occludes the other window.
    const window = new BrowserWindow({
      x: index * 820, y: 0, width: 800, height: 600,
      webPreferences: {
        sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true,
        backgroundThrottling: false, partition: `voice-runtime-probe-${peer}`,
      },
    });
    windows.push(window);
    window.webContents.on('render-process-gone', () => { globalThis.voiceProbeLifecycle.rendererCrashes++; });
    window.webContents.on('did-fail-load', (_event, _code, _description, _url, isMainFrame) => {
      if (isMainFrame) globalThis.voiceProbeLifecycle.navigationFailures++;
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    void window.loadURL('about:blank');
  }
});
app.on('window-all-closed', () => app.quit());
