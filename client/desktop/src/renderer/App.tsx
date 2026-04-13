import { Suspense, lazy, useEffect, useState } from 'react';
import * as Sentry from '@sentry/react';
import { Routes, Route, Navigate, Outlet, useNavigate } from 'react-router-dom';
import AuthFlow from './components/Auth/AuthFlow';
import MainView from './components/MainView/MainView';
import DirectMessagesView from './components/DirectMessages/DirectMessagesView';
import ContextMenuProvider from './components/ui/ContextMenuProvider';
import ConnectionLostOverlay from './components/ui/ConnectionLostOverlay';
import SettingsOverlayHost from './components/Settings/SettingsOverlayHost';
const PipWindow = lazy(() => import('./components/Voice/PipWindow'));
import ForceUpdateOverlay from './components/ui/ForceUpdateOverlay';
import UpdateBanner from './components/ui/UpdateBanner';
import MFAChallengeModal from './components/Auth/MFAChallengeModal';
import { useAuthStore } from './stores/authStore';
import { useUserStore } from './stores/userStore';
import { useVideoSettingsStore } from './stores/videoSettingsStore';
import { useOsPermissionStore, type OsPermissionType } from './stores/osPermissionStore';
import { useWebSocket } from './hooks/useWebSocket';
import { e2eeService } from './services/e2eeService';
import { preferencesSyncService, type PreferencesSyncDeps } from './services/preferencesSync';
import { useSettingsStore } from './stores/settingsStore';
import { useLayoutStore } from './stores/layoutStore';
import { savedGifsSyncService } from './services/savedGifsSync';
import { usePrivacyStore } from './stores/privacyStore';
import { klipyClient } from './services/gifProvider/klipyClient';
import { clientConfigService } from './services/clientConfigService';
import { detectCodecCapabilities, prewarmWebRTC } from './services/mediaCapabilities';
import { useNotificationNavigationStore } from './stores/notificationNavigationStore';
import { useServerStore } from './stores/serverStore';
import { useChannelStore } from './stores/channelStore';
import { useDMStore } from './stores/dmStore';
import { desktopNotificationService } from './services/desktopNotificationService';
// resetService is loaded on-demand via dynamic import() to allow code splitting

// ─── Sentry Error Boundary Fallbacks ──────────────────────────────────
// Static text only — no user data, no display names, no avatars.
// showDialog={false} is mandatory on every boundary (Sentry's default
// feedback dialog collects email, violating our PII allowlist).

export function AppRootFallback() {
  return (
    <div className="error-boundary-fallback error-boundary-fallback--fatal">
      <h2>Something went wrong</h2>
      <p>The error has been reported. Please restart the application.</p>
      <button onClick={() => globalThis.location.reload()}>Reload</button>
    </div>
  );
}

export function AuthenticatedViewFallback() {
  return (
    <div className="error-boundary-fallback">
      <h2>This view failed to load</h2>
      <p>The error has been reported. Try selecting a different view.</p>
    </div>
  );
}

export function SettingsFallback() {
  return (
    <div className="error-boundary-fallback">
      <h2>Settings failed to load</h2>
      <p>The error has been reported. Close and reopen settings to try again.</p>
    </div>
  );
}

export function PipFallback() {
  return (
    <div className="error-boundary-fallback">
      <h2>Voice UI crashed</h2>
      <p>Your call is still active. Close this window and rejoin from the main app.</p>
    </div>
  );
}

export function AuthFallback() {
  return (
    <div className="error-boundary-fallback">
      <h2>Authentication UI failed to load</h2>
      <p>The error has been reported.</p>
      <button onClick={() => globalThis.location.reload()}>Reload</button>
    </div>
  );
}

/** Soft-restart on fatal render crash — preserves session, avoids nuclear reset. */
export function handleAppRootError() {
  import('./services/recoveryService')
    .then((m) => m.markRendererCrashed())
    .catch((err) => console.error('[App] Failed to mark renderer crashed:', err));
  import('./services/resetService')
    .then((m) => m.softRestart())
    .catch((err) => {
      console.error('[App] Failed to soft-restart, forcing reload:', err);
      globalThis.location.reload();
    });
}

// ─── Authenticated Layout ──────────────────────────────────────────────

function AuthenticatedLayout() {
  const accessToken = useAuthStore((state) => state.accessToken);
  const emailVerified = useAuthStore((state) => state.emailVerified);
  const user = useUserStore((state) => state.user);
  const fetchUser = useUserStore((state) => state.fetchUser);
  const navigate = useNavigate();

  // Single WebSocket connection that persists across all authenticated routes
  useWebSocket();

  // Handle notification click navigation (#175) — must live here (not MainView)
  // so it works regardless of which authenticated route is active.
  useEffect(() => {
    const unsub = useNotificationNavigationStore.subscribe((state) => {
      const nav = state.pendingNavigation;
      if (!nav) return;

      if (nav.type === 'channel' && nav.serverId) {
        const serverStore = useServerStore.getState();
        if (serverStore.activeServerId !== nav.serverId) {
          serverStore.setActiveServer(nav.serverId);
        }
        useChannelStore.getState().setActiveChannel(nav.targetId);
        navigate('/app');
      } else if (nav.type === 'dm') {
        useDMStore.getState().setActiveConversation(nav.targetId);
        navigate('/app/dms');
      }

      desktopNotificationService.clearBadge();
      useNotificationNavigationStore.getState().clearPendingNavigation();
    });

    return unsub;
  }, [navigate]);

  // Eagerly fetch user profile when authenticated (before child routes mount)
  useEffect(() => {
    if (accessToken && !user) {
      fetchUser();
    }
  }, [accessToken, user, fetchUser]);

  // Pre-warm WebRTC engine + voice chunk so first voice join is fast (~200ms vs ~2s)
  useEffect(() => {
    prewarmWebRTC();
  }, []);

  // Load privacy settings + wire KLIPY personalization preference.
  // KLIPY traffic always routes through the control-plane proxy now, so we
  // only need to forward the personalization (customer_id) preference.
  useEffect(() => {
    if (!accessToken) return;
    const applyKlipyMode = (s: ReturnType<typeof usePrivacyStore.getState>['settings']) => {
      klipyClient.setPersonalizationEnabled(s.sharePersonalizationWithGifProvider);
    };
    usePrivacyStore
      .getState()
      .fetchPrivacy()
      .then(() => {
        applyKlipyMode(usePrivacyStore.getState().settings);
      });
    const unsub = usePrivacyStore.subscribe((state) => applyKlipyMode(state.settings));
    return () => unsub();
  }, [accessToken]);

  // Pre-cache codec capabilities, GPU info, and detect system HDR
  useEffect(() => {
    Promise.all([
      detectCodecCapabilities(),
      globalThis.electron?.getGPUInfo?.() ?? Promise.resolve(null),
      globalThis.electron?.getHardwareAcceleration?.() ?? Promise.resolve(null),
      globalThis.electron?.getDisplayInfo?.() ?? Promise.resolve(null),
    ]).then(([caps, gpu, hwAccel, displays]) => {
      // Detect HDR: any display with colorDepth > 24 or wide gamut color space
      const systemHdr =
        (displays as { colorDepth?: number; colorSpace?: string }[] | null)?.some(
          (d) => (d.colorDepth ?? 0) > 24 || (d.colorSpace && d.colorSpace !== 'srgb')
        ) ?? false;

      const current = useVideoSettingsStore.getState();
      useVideoSettingsStore.setState({
        codecCapabilities: caps,
        gpuInfo: gpu ?? current.gpuInfo,
        systemHdr,
        ...(hwAccel == null ? {} : { hardwareAcceleration: hwAccel }),
      });

      // Auto-enable HDR encoding on first detection if user hasn't explicitly toggled it
      if (systemHdr && !current.hdrEncoding) {
        useVideoSettingsStore.getState().setHdrEncoding(true);
      }
    });
  }, []);

  if (!accessToken) {
    return <Navigate to="/" replace />;
  }

  // Redirect unverified users back to auth flow (which will show email verification)
  if (!emailVerified) {
    return <Navigate to="/" replace />;
  }

  return (
    <>
      <Sentry.ErrorBoundary
        fallback={<AuthenticatedViewFallback />}
        showDialog={false}
        beforeCapture={(scope) => scope.setTag('boundary', 'authenticated-view')}
      >
        <Outlet />
      </Sentry.ErrorBoundary>
      <Sentry.ErrorBoundary
        fallback={<SettingsFallback />}
        showDialog={false}
        beforeCapture={(scope) => scope.setTag('boundary', 'settings')}
      >
        <SettingsOverlayHost />
      </Sentry.ErrorBoundary>
      <ConnectionLostOverlay />
    </>
  );
}

// ─── App Root ──────────────────────────────────────────────────────────

// Module-level guard: React Strict Mode (dev) double-mounts the component,
// firing useEffect twice. Without this flag, two restoreSession IPC calls
// can trigger two sequential token rotations.
let restoreSessionCalled = false;

/** Build the dependency bag for preferencesSyncService — extracted to reduce nesting depth. */
function buildPreferencesSyncDeps(): PreferencesSyncDeps {
  return {
    getAppearance: () => useSettingsStore.getState().appearance,
    setAppearance: (patch) =>
      useSettingsStore.setState((s) => ({ appearance: { ...s.appearance, ...patch } })),
    getLayout: () => {
      const s = useLayoutStore.getState();
      return {
        channelPanelPinned: s.channelPanelPinned,
        channelPanelWidth: s.channelPanelWidth,
        memberPanelMode: s.memberPanelMode,
        memberPanelWidth: s.memberPanelWidth,
        serverBarHeight: s.serverBarHeight,
        folderBarHeight: s.folderBarHeight,
        serverFolders: s.serverFolders,
        serverOrder: s.serverOrder,
      };
    },
    setLayout: (patch) => useLayoutStore.setState(patch),
  };
}

function App() {
  const [version, setVersion] = useState<string>('');
  const [platform, setPlatform] = useState<string>('');
  // PiP windows don't need auth — they communicate via BroadcastChannel.
  // Skip session restore entirely to avoid unnecessary token rotations.
  const isPipWindow = globalThis.location.hash.startsWith('#/pip/');
  const [isRestoring, setIsRestoring] = useState(!isPipWindow);
  const accessToken = useAuthStore((state) => state.accessToken);
  const emailVerified = useAuthStore((state) => state.emailVerified);

  // Restore session on startup: ask main process to decrypt the
  // safeStorage-encrypted refresh token and exchange it for a fresh
  // access token, so users with "Remember Me" don't see a login flash.
  // Note: the IPC handler is also deduplicated in main.ts, but we guard
  // here as well to avoid even making a redundant IPC call.
  useEffect(() => {
    if (isPipWindow) return; // PiP windows skip session restore
    // Already authenticated (login succeeded, or HMR re-mounted the component)
    // — no need to hit restoreSession again.
    if (useAuthStore.getState().accessToken) {
      setIsRestoring(false);
      return;
    }
    if (restoreSessionCalled) {
      setIsRestoring(false);
      return;
    }
    restoreSessionCalled = true;

    const restore = async () => {
      if (!globalThis.electron?.restoreSession) {
        setIsRestoring(false);
        return;
      }

      const result = await globalThis.electron.restoreSession();
      if (result.status === 'restored' && result.accessToken) {
        useAuthStore.getState().setAccessToken(result.accessToken);
        if (result.sessionId) useAuthStore.getState().setSessionId(result.sessionId);

        // Restore E2EE service from safeStorage-persisted key material
        if (result.e2eeKeys) {
          try {
            await e2eeService.initializeFromStoredKeys(result.e2eeKeys);
            preferencesSyncService.init(buildPreferencesSyncDeps());
            preferencesSyncService.startWatching();
            await preferencesSyncService.fetchAndApply();
            savedGifsSyncService.startWatching();
            await savedGifsSyncService.fetchAndApply();
            console.debug('E2EE service restored from stored session keys');
          } catch (err) {
            console.warn('Failed to restore E2EE keys — E2EE features will require re-login:', err);
          }
        }
      } else {
        // Session cannot be restored — clear content stores but keep disk tokens.
        // The refresh may have failed due to a transient error (server not ready,
        // network issue). Preserving disk tokens allows the next launch to retry.
        // If the user logs in fresh, new tokens overwrite the old files anyway.
        console.warn('[App] Session restore failed:', result.status);
        const { gracefulReset } = await import('./services/resetService');
        gracefulReset();
      }
      setIsRestoring(false);
    };
    restore();
  }, [isPipWindow]);

  useEffect(() => {
    // Get app info from Electron main process
    if (globalThis.electron) {
      globalThis.electron.getVersion().then(setVersion);
      globalThis.electron.getPlatform().then(setPlatform);
    }

    // Initialize OS permission state (non-blocking) and subscribe to changes (#197)
    let unsubPermission: (() => void) | undefined;
    if (globalThis.electron) {
      useOsPermissionStore.getState().fetchAll();
      // Guard for IPC contract mismatch — older shells may lack v3 permission channels
      if (typeof globalThis.electron.onPermissionChanged === 'function') {
        unsubPermission = globalThis.electron.onPermissionChanged((data) => {
          useOsPermissionStore.getState().updateStatus(data.type as OsPermissionType, data.status);
        });
      }
    }
    return () => {
      unsubPermission?.();
    };
  }, []);

  // Poll server for client config (feature flags, min version, TURN/media-plane URLs).
  // Runs at App root so minVersion enforcement works regardless of auth state.
  useEffect(() => {
    clientConfigService.start();
    return () => clientConfigService.stop();
  }, []);

  if (isRestoring) {
    return (
      <ContextMenuProvider>
        <div className="app">
          <div className="title-bar">
            <div className="title-bar-text">Concord Voice</div>
          </div>
        </div>
      </ContextMenuProvider>
    );
  }

  return (
    <Sentry.ErrorBoundary
      fallback={<AppRootFallback />}
      showDialog={false}
      beforeCapture={(scope) => scope.setTag('boundary', 'app-root')}
      onError={handleAppRootError}
    >
      <ContextMenuProvider>
        <div className="app">
          <div className="title-bar">
            <div className="title-bar-text">Concord Voice</div>
            {version && (
              <div className="title-bar-info">
                v{version} • {platform}
              </div>
            )}
          </div>
          <UpdateBanner />

          <ForceUpdateOverlay />
          <MFAChallengeModal />
          <Suspense fallback={null}>
            <Routes>
              <Route
                path="/"
                element={
                  accessToken && emailVerified ? (
                    <Navigate to="/app/dms" replace />
                  ) : (
                    <Sentry.ErrorBoundary
                      fallback={<AuthFallback />}
                      showDialog={false}
                      beforeCapture={(scope) => scope.setTag('boundary', 'auth-flow')}
                    >
                      <AuthFlow />
                    </Sentry.ErrorBoundary>
                  )
                }
              />
              <Route element={<AuthenticatedLayout />}>
                <Route path="/app" element={<MainView />} />
                <Route path="/app/dms" element={<DirectMessagesView />} />
              </Route>
              {/* PiP windows — separate Electron BrowserWindows, state synced via BroadcastChannel */}
              <Route
                path="/pip/:pipId"
                element={
                  <Sentry.ErrorBoundary
                    fallback={<PipFallback />}
                    showDialog={false}
                    beforeCapture={(scope) => scope.setTag('boundary', 'pip-window')}
                  >
                    <PipWindow />
                  </Sentry.ErrorBoundary>
                }
              />
            </Routes>
          </Suspense>
        </div>
      </ContextMenuProvider>
    </Sentry.ErrorBoundary>
  );
}

export default App;
