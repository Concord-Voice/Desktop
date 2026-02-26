import { useEffect, useState } from 'react';
import { Routes, Route, Navigate, Outlet } from 'react-router-dom';
import AuthFlow from './components/Auth/AuthFlow';
import MainView from './components/MainView/MainView';
import ProfilePage from './components/Profile/ProfilePage';
import SettingsPage from './components/Settings/SettingsPage';
import PipWindow from './components/Voice/PipWindow';
import ConnectionLostOverlay from './components/ui/ConnectionLostOverlay';
import { useAuthStore } from './stores/authStore';
import { useUserStore } from './stores/userStore';
import { useWebSocket } from './hooks/useWebSocket';

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
  return (
    <>
      <Outlet />
      <ConnectionLostOverlay />
    </>
  );
}

function App() {
  const [version, setVersion] = useState<string>('');
  const [platform, setPlatform] = useState<string>('');

  useEffect(() => {
    // Get app info from Electron main process
    if (window.electron) {
      window.electron.getVersion().then(setVersion);
      window.electron.getPlatform().then(setPlatform);
    }
  }, []);

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
        <Route path="/" element={<AuthFlow />} />
        <Route element={<AuthenticatedLayout />}>
          <Route path="/app" element={<MainView />} />
          <Route path="/app/profile" element={<ProfilePage />} />
          <Route path="/app/settings" element={<SettingsPage />} />
        </Route>
        {/* PiP windows — separate Electron BrowserWindows, state synced via BroadcastChannel */}
        <Route path="/pip/:pipId" element={<PipWindow />} />
      </Routes>
    </div>
  );
}

export default App;
