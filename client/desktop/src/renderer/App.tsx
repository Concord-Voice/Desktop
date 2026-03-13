import {
  Component,
  Suspense,
  lazy,
  useEffect,
  useState,
  type ErrorInfo,
  type ReactNode,
} from 'react';
import { Routes, Route, Navigate, Outlet } from 'react-router-dom';
import AuthFlow from './components/Auth/AuthFlow';
import MainView from './components/MainView/MainView';
import DirectMessagesView from './components/DirectMessages/DirectMessagesView';
const ProfilePage = lazy(() => import('./components/Profile/ProfilePage'));
const SettingsPage = lazy(() => import('./components/Settings/SettingsPage'));
const ServerSettingsPage = lazy(() => import('./components/Servers/ServerSettingsPage'));
const PipWindow = lazy(() => import('./components/Voice/PipWindow'));
import ConnectionLostOverlay from './components/ui/ConnectionLostOverlay';
import MFAChallengeModal from './components/Auth/MFAChallengeModal';
import { useAuthStore } from './stores/authStore';
import { useUserStore } from './stores/userStore';
import { useVideoSettingsStore } from './stores/videoSettingsStore';
import { useWebSocket } from './hooks/useWebSocket';
import { e2eeService } from './services/e2eeService';
import { preferencesSyncService } from './services/preferencesSync';
import { detectCodecCapabilities, prewarmWebRTC } from './services/mediaCapabilities';
// resetService is loaded on-demand via dynamic import() to allow code splitting

// ─── Error Boundary ────────────────────────────────────────────────────
// Catches unhandled rendering errors. Instead of going nuclear (which wipes
// auth tokens and shows login), marks the renderer as crashed and performs a
// soft restart — preserving the session for automatic recovery.

interface ErrorBoundaryState {
  hasError: boolean;
}

class AppErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[AppErrorBoundary] Unhandled error — soft restart:', error, info.componentStack);
    import('./services/recoveryService').then((m) => m.markRendererCrashed());
    import('./services/resetService').then((m) => m.softRestart());
  }

  render() {
    if (this.state.hasError) {
      return <AuthFlow />;
    }
    return this.props.children;
  }
}

// ─── Authenticated Layout ──────────────────────────────────────────────

function AuthenticatedLayout() {
  const accessToken = useAuthStore((state) => state.accessToken);
  const user = useUserStore((state) => state.user);
  const fetchUser = useUserStore((state) => state.fetchUser);

  // Single WebSocket connection that persists across all authenticated routes
  useWebSocket();

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

  // Pre-cache codec capabilities, GPU info, and detect system HDR
  useEffect(() => {
    Promise.all([
      detectCodecCapabilities(),
      window.electron?.getGPUInfo?.() ?? Promise.resolve(null),
      window.electron?.getHardwareAcceleration?.() ?? Promise.resolve(null),
      window.electron?.getDisplayInfo?.() ?? Promise.resolve(null),
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
        ...(hwAccel != null ? { hardwareAcceleration: hwAccel } : {}),
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
  return (
    <>
      <Outlet />
      <ConnectionLostOverlay />
    </>
  );
}

// ─── App Root ──────────────────────────────────────────────────────────

// Module-level guard: React Strict Mode (dev) double-mounts the component,
// firing useEffect twice. Without this flag, two restoreSession IPC calls
// can trigger two sequential token rotations.
let restoreSessionCalled = false;

function App() {
  const [version, setVersion] = useState<string>('');
  const [platform, setPlatform] = useState<string>('');
  // PiP windows don't need auth — they communicate via BroadcastChannel.
  // Skip session restore entirely to avoid unnecessary token rotations.
  const isPipWindow = window.location.hash.startsWith('#/pip/');
  const [isRestoring, setIsRestoring] = useState(!isPipWindow);
  const accessToken = useAuthStore((state) => state.accessToken);

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
      if (!window.electron?.restoreSession) {
        setIsRestoring(false);
        return;
      }

      const result = await window.electron.restoreSession();
      if (result.status === 'restored' && result.accessToken) {
        useAuthStore.getState().setAccessToken(result.accessToken);
        if (result.sessionId) useAuthStore.getState().setSessionId(result.sessionId);

        // Restore E2EE service from safeStorage-persisted key material
        if (result.e2eeKeys) {
          try {
            await e2eeService.initializeFromStoredKeys(result.e2eeKeys);
            preferencesSyncService.startWatching();
            await preferencesSyncService.fetchAndApply();
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
    if (window.electron) {
      window.electron.getVersion().then(setVersion);
      window.electron.getPlatform().then(setPlatform);
    }
  }, []);

  if (isRestoring) {
    return (
      <div className="app" onContextMenu={(e) => e.preventDefault()}>
        <div className="title-bar">
          <div className="title-bar-text">Concord Voice</div>
        </div>
      </div>
    );
  }

  return (
    <AppErrorBoundary>
      <div className="app" onContextMenu={(e) => e.preventDefault()}>
        <div className="title-bar">
          <div className="title-bar-text">Concord Voice</div>
          {version && (
            <div className="title-bar-info">
              v{version} • {platform}
            </div>
          )}
        </div>

        <MFAChallengeModal />
        <Suspense fallback={null}>
          <Routes>
            <Route
              path="/"
              element={accessToken ? <Navigate to="/app/dms" replace /> : <AuthFlow />}
            />
            <Route element={<AuthenticatedLayout />}>
              <Route path="/app" element={<MainView />} />
              <Route path="/app/dms" element={<DirectMessagesView />} />
              <Route path="/app/profile" element={<ProfilePage />} />
              <Route path="/app/settings" element={<SettingsPage />} />
              <Route path="/app/server-settings/:serverId" element={<ServerSettingsPage />} />
            </Route>
            {/* PiP windows — separate Electron BrowserWindows, state synced via BroadcastChannel */}
            <Route path="/pip/:pipId" element={<PipWindow />} />
          </Routes>
        </Suspense>
      </div>
    </AppErrorBoundary>
  );
}

export default App;
