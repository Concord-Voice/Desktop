import { useEffect, useState } from 'react';
import { Routes, Route, Navigate, Outlet } from 'react-router-dom';
import AuthFlow from './components/Auth/AuthFlow';
import MainView from './components/MainView/MainView';
import ProfilePage from './components/Profile/ProfilePage';
import SettingsPage from './components/Settings/SettingsPage';
import { useAuthStore } from './stores/authStore';
import { useUserStore } from './stores/userStore';
import { useWebSocket } from './hooks/useWebSocket';
import { refreshAccessToken } from './services/apiClient';

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

  if (!accessToken) {
    return <Navigate to="/" replace />;
  }
  return <Outlet />;
}

function App() {
  const [version, setVersion] = useState<string>('');
  const [platform, setPlatform] = useState<string>('');
  const [isRestoring, setIsRestoring] = useState(true);
  const accessToken = useAuthStore((state) => state.accessToken);

  // Restore session on startup: wait for Zustand persist hydration,
  // then proactively refresh the access token so users with
  // "Remember Me" checked don't see a login flash
  useEffect(() => {
    const restore = async () => {
      // Wait for Zustand persist to hydrate from localStorage
      if (!useAuthStore.persist.hasHydrated()) {
        await new Promise<void>((resolve) => {
          useAuthStore.persist.onFinishHydration(() => resolve());
        });
      }

      const { accessToken } = useAuthStore.getState();
      if (accessToken) {
        const newToken = await refreshAccessToken();
        if (!newToken) {
          useAuthStore.getState().clearTokens();
        }
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
          <div className="title-bar-text">Concord</div>
        </div>
      </div>
    );
  }

  return (
    <div className="app" onContextMenu={(e) => e.preventDefault()}>
      <div className="title-bar">
        <div className="title-bar-text">Concord</div>
        {version && (
          <div className="title-bar-info">
            v{version} • {platform}
          </div>
        )}
      </div>

      <Routes>
        <Route path="/" element={accessToken ? <Navigate to="/app" replace /> : <AuthFlow />} />
        <Route element={<AuthenticatedLayout />}>
          <Route path="/app" element={<MainView />} />
          <Route path="/app/profile" element={<ProfilePage />} />
          <Route path="/app/settings" element={<SettingsPage />} />
        </Route>
      </Routes>
    </div>
  );
}

export default App;
