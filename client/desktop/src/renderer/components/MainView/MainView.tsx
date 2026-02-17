import React, { useState } from 'react';
import CreateServerModal from '../Servers/CreateServerModal';
import { Server } from '../../types/server';
import './MainView.css';

const MainView: React.FC = () => {
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [servers, setServers] = useState<Server[]>([]);

  const handleCreateSuccess = (server: Server) => {
    setServers((prev) => [server, ...prev]);
  };

  return (
    <div className="view-container main-view">
      <div className="sidebar">
        <div className="sidebar-servers">
          {servers.map((server) => (
            <div key={server.id} className="server-icon-btn" title={server.name}>
              {server.icon_url ? (
                <img src={server.icon_url} alt={server.name} className="server-icon-img" />
              ) : (
                <span className="server-icon-initial">
                  {server.name.charAt(0).toUpperCase()}
                </span>
              )}
            </div>
          ))}

          <button
            className="add-server-btn"
            onClick={() => setIsCreateModalOpen(true)}
            title="Create a Server"
            aria-label="Create a Server"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <path d="M10 4v12M4 10h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
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

      <CreateServerModal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        onSuccess={handleCreateSuccess}
      />
    </div>
  );
};

export default MainView;
