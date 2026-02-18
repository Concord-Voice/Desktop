import React, { useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import AuthFlow from './components/Auth/AuthFlow';
import MainView from './components/MainView/MainView';
import { useAuthStore } from './stores/authStore';
import { useWebSocket } from './hooks/useWebSocket';

function ProtectedRoute({ children }: { children: React.ReactElement }) {
  const accessToken = useAuthStore((state) => state.accessToken);
  // Initialize WebSocket for authenticated users
  useWebSocket();

  if (!accessToken) {
    return <Navigate to="/" replace />;
  }
  return children;
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
    <div className="app">
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
        <Route path="/app" element={
          <ProtectedRoute>
            <MainView />
          </ProtectedRoute>
        } />
      </Routes>
    </div>
  );
}

export default App;
