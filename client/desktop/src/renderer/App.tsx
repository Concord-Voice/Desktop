import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from 'react';
import { Routes, Route, Navigate, Outlet } from 'react-router-dom';
import AuthFlow from './components/Auth/AuthFlow';
import MainView from './components/MainView/MainView';
import DirectMessagesView from './components/DirectMessages/DirectMessagesView';
import ProfilePage from './components/Profile/ProfilePage';
import SettingsPage from './components/Settings/SettingsPage';
import PipWindow from './components/Voice/PipWindow';
import ConnectionLostOverlay from './components/ui/ConnectionLostOverlay';
import { useAuthStore } from './stores/authStore';
import { useUserStore } from './stores/userStore';
import { useVideoSettingsStore } from './stores/videoSettingsStore';
import { useWebSocket } from './hooks/useWebSocket';
import { e2eeService } from './services/e2eeService';
import { preferencesSyncService } from './services/preferencesSync';
import { detectCodecCapabilities, prewarmWebRTC } from './services/mediaCapabilities';
import { nuclearReset } from './services/resetService';

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
      const systemHdr = (displays as { colorDepth?: number; colorSpace?: string }[] | null)?.some(
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

function App() {
  const [version, setVersion] = useState<string>('');
  const [platform, setPlatform] = useState<string>('');
  const [isRestoring, setIsRestoring] = useState(true);
  const accessToken = useAuthStore((state) => state.accessToken);

  // Restore session on startup: ask main process to decrypt the
  // safeStorage-encrypted refresh token and exchange it for a fresh
  // access token, so users with "Remember Me" don't see a login flash
  useEffect(() => {
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
        // Session cannot be restored — nuclear reset to ensure clean login screen
        nuclearReset();
      }
      setIsRestoring(false);
    };
    restore();
  }, []);

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

        <Routes>
          <Route path="/" element={accessToken ? <Navigate to="/app/dms" replace /> : <AuthFlow />} />
          <Route element={<AuthenticatedLayout />}>
            <Route path="/app" element={<MainView />} />
            <Route path="/app/dms" element={<DirectMessagesView />} />
            <Route path="/app/profile" element={<ProfilePage />} />
            <Route path="/app/settings" element={<SettingsPage />} />
          </Route>
          {/* PiP windows — separate Electron BrowserWindows, state synced via BroadcastChannel */}
          <Route path="/pip/:pipId" element={<PipWindow />} />
        </Routes>
      </div>
    </AppErrorBoundary>
  );
}

export default App;
