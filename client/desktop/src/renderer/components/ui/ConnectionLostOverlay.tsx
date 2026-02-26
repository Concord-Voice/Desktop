import React from 'react';
import { WifiOff } from 'lucide-react';
import { useConnectionStore } from '../../stores/connectionStore';
import './ConnectionLostOverlay.css';

const ConnectionLostOverlay: React.FC = () => {
  const showOverlay = useConnectionStore((s) => s.showOverlay);

  if (!showOverlay) return null;

  const handleExit = () => {
    if (window.electron?.quitApp) {
      window.electron.quitApp();
    } else {
      window.close();
    }
  };

  return (
    <div className="connection-lost-overlay">
      <div className="connection-lost-card">
        <div className="connection-lost-icon">
          <WifiOff size={48} />
        </div>
        <h2 className="connection-lost-title">Connection Lost</h2>
        <p className="connection-lost-message">
          We&apos;ve lost connection to the server. Reconnection attempts are
          ongoing in the background. If connection is restored, you&apos;ll
          start a fresh session.
        </p>
        <button className="connection-lost-exit" onClick={handleExit}>
          Exit App
        </button>
      </div>
    </div>
  );
};

export default ConnectionLostOverlay;
