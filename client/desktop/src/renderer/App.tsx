import React, { useEffect, useState } from 'react';
import { Routes, Route } from 'react-router-dom';
import AuthFlow from './components/Auth/AuthFlow';

const MainView = () => (
  <div className="view-container main-view">
    <div className="sidebar">
      <div className="sidebar-section">
        <h3>Servers</h3>
        <p className="placeholder-text">No servers yet</p>
      </div>
    </div>
    <div className="content">
      <div className="channels-sidebar">
        <h3>Channels</h3>
        <p className="placeholder-text">Select a server</p>
      </div>
      <div className="main-content">
        <h2>Welcome to Concord</h2>
        <p>Privacy-first, self-hostable voice communication.</p>
      </div>
    </div>
  </div>
);

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
        <Route path="/app" element={<MainView />} />
      </Routes>
    </div>
  );
}

export default App;
