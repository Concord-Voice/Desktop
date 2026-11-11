// Checked-in admission class of every IPC channel main registers (spec
// 2026-11-09-86-connection-context-isolation §3.7). `registerIpc` refuses a channel
// absent from this table and a class that differs from it, and
// tests/unit/main/ipc/channelClassification.test.ts compares the table against the
// tree's `registerIpc` call sites in both directions.
//
// Classes (ipc/registry.ts): connection-bound → any bound primary, custody from its
// own binding; app-global-read → any bound primary, grants nothing per connection;
// app-global-mutate → the foreground primary only; saas-only → the `saas` primary;
// pip-scoped → a bound PiP or its primary; exempt-low-stakes → the foreground
// primary, a silent no-op otherwise.
//
// Changing a row is a security decision: a wider class lets a background or
// self-hosted connection reach the channel. Record the reason in electron.md
// § IPC contract v34.

import type { AdmissionClass } from './registry';

export const CHANNEL_CLASSES: Readonly<Record<string, AdmissionClass>> = Object.freeze({
  // connection:* (contract v34). `connection:whoAmI` is the one `ipcMain.on` +
  // `returnValue` channel in ipc/connection.ts; it never goes through registerIpc,
  // and its row records who may read an identity (a bound PiP or primary).
  'connection:whoAmI': 'pip-scoped',
  'connection:create': 'app-global-mutate',
  'connection:activate': 'app-global-mutate',
  // #86 T9: each primary reads only its own scope, so any bound primary may ask; a
  // PiP has no preferences of its own.
  'connection:preferenceScope': 'connection-bound',

  // App facts.
  // #86 Task 7B pass 2: pip-scoped because the PiP window renders App's main tree and
  // ChangelogModalHost asks for the version on mount there. A PiP has the same read.
  'app:getVersion': 'pip-scoped',
  'app:getPlatform': 'app-global-read',
  'app:getIpcContract': 'app-global-read',
  'app:getBuildTag': 'app-global-read',
  'app:getSystemInfo': 'app-global-read',
  'gpu:getInfo': 'app-global-read',
  'screen:getDisplayInfo': 'app-global-read',
  'window:getVersionString': 'app-global-read',
  'auth:getCapabilities': 'app-global-read',

  // App-wide settings and lifecycle: the foreground connection only.
  'app:getHardwareAcceleration': 'app-global-read',
  'app:setHardwareAcceleration': 'app-global-mutate',
  'app:getContentProtection': 'app-global-read',
  'app:setContentProtection': 'app-global-mutate',
  'app:getDeveloperMode': 'app-global-read',
  'app:setDeveloperMode': 'app-global-mutate',
  'app:relaunch': 'app-global-mutate',
  'app:quit': 'app-global-mutate',
  'window:quit': 'app-global-mutate',
  'update:check': 'app-global-mutate',
  'update:download': 'app-global-mutate',
  'update:install': 'app-global-mutate',
  'update:getAllowPrerelease': 'app-global-read',
  'update:setAllowPrerelease': 'app-global-mutate',
  'update:getLogPath': 'app-global-read',
  'updater:force-check': 'app-global-mutate',
  'permission:checkAll': 'app-global-read',
  'permission:check': 'app-global-read',
  'permission:request': 'app-global-mutate',
  'permission:openSettings': 'app-global-mutate',
  // A hidden view must not replace the clipboard behind the visible one.
  'clipboard:writeText': 'app-global-mutate',
  // #86 Task 7B: the screen-share picker's sources carry a thumbnail of every window
  // and screen, so a hidden view must not enumerate them (as for audiocap:start).
  'media:getDesktopSources': 'app-global-mutate',
  // #86 Task 7B pass 2 (accepted security finding): a hidden connection must not start
  // system-audio capture, so a start is admitted from the foreground primary only. The
  // handler re-checks foreground after its await and refuses while ANOTHER connection
  // owns a live share. audiocap:stop stays connection-bound: a hidden owner may still
  // end its own share, and the handler admits the owner alone.
  'audiocap:start': 'app-global-mutate',
  // #86 Task 7B (tray:setStatus): connection-bound so the registry admits any bound primary; the
  // handler then narrows to trayOwner() when #87 names one, else the foreground
  // primary. With no owner set the effective admission is the foreground primary.
  'tray:setStatus': 'connection-bound',

  // Window chrome: the foreground primary, a silent no-op otherwise.
  'window:setTitleBarOverlayColor': 'exempt-low-stakes',
  'window:setClientBehavior': 'exempt-low-stakes',

  // Per connection: custody, credentials and documents come from the binding.
  'auth:storeRefreshToken': 'connection-bound',
  'auth:restoreSession': 'connection-bound',
  'auth:storeE2EEKeys': 'connection-bound',
  'auth:storeE2EEKeysIfOwner': 'connection-bound',
  'auth:refreshToken': 'connection-bound',
  'auth:logout': 'connection-bound',
  'auth:clearTokens': 'connection-bound',
  'auth:clearTokensIfOwner': 'connection-bound',
  'auth:getMachineId': 'connection-bound',
  'attestation:get-token': 'connection-bound',
  'attestation:clear-token': 'connection-bound',
  'sso:startLoopback': 'connection-bound',
  'sso:awaitCallback': 'connection-bound',
  'sso:cancelLoopback': 'connection-bound',
  'sso:completeRegistration': 'connection-bound',
  'sso:completeLink': 'connection-bound',
  'sso:completeMFA': 'connection-bound',
  'sso:abandonReservation': 'connection-bound',
  'sso:appleSignIn': 'connection-bound',
  'sso:appleCancel': 'connection-bound',
  'sso:googleSignIn': 'connection-bound',
  'sso:googleCancel': 'connection-bound',
  'selfHosted:probeServer': 'connection-bound',
  'audiocap:stop': 'connection-bound',
  'open-external': 'connection-bound',
  'image:saveAs': 'connection-bound',
  'app:setBadgeCount': 'connection-bound',
  'app:flashFrame': 'connection-bound',
  'app:focusWindow': 'connection-bound',
  'spa:requestSelfHeal': 'connection-bound',
  'pip:open': 'connection-bound',

  // The PiP window and its opener.
  'pip:close': 'pip-scoped',
  'pip:setAlwaysOnTop': 'pip-scoped',
  'pip:session': 'pip-scoped',

  // saas only: deep links, the remote-SPA cache and billing.
  'deeplink:forget': 'saas-only',
  'deeplink:renderer-ready': 'saas-only',
  'invite:renderer-ready': 'saas-only',
  'spa:reloadLatest': 'saas-only',
  'spa:checkForUpdate': 'saas-only',
  'billing:open': 'saas-only',
});
