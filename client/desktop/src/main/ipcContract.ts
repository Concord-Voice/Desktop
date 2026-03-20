/**
 * IPC Contract Version — the compatibility boundary between shell and renderer.
 *
 * This integer ONLY bumps when the IPC surface changes:
 * - New ipcMain.handle() channels added
 * - Existing channel signatures change
 * - Channels removed
 *
 * It does NOT bump for renderer-only changes (React components, CSS, services).
 *
 * The server's client config returns `spaIpcContract` — the minimum contract
 * version required by the remote SPA. If the shell's contract version is below
 * that, the shell falls back to its bundled SPA and triggers auto-update.
 *
 * History:
 * - v1: Initial contract (auth, clipboard, GPU, display, PiP, HW accel)
 * - v2: Auto-update channels (update:check/download/install/getAllowPrerelease/
 *        setAllowPrerelease), update events (available/not-available/progress/
 *        downloaded/error), app:getSystemInfo, app:getIpcContract
 * - v3: OS permission management channels (permission:checkAll, permission:check,
 *        permission:request, permission:openSettings), permission:changed event
 */
export const IPC_CONTRACT_VERSION = 3;
