import React, { useState } from 'react';
import ServerList from '../Servers/ServerList';
import ServerContextMenu from '../Servers/ServerContextMenu';
import ServerSettingsModal from '../Servers/ServerSettingsModal';
import DeleteServerModal from '../Servers/DeleteServerModal';
import CreateServerModal from '../Servers/CreateServerModal';
import { useServerStore } from '../../stores/serverStore';
import { ServerWithRole } from '../../types/server';
import './MainView.css';

const MainView: React.FC = () => {
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    server: ServerWithRole;
    position: { x: number; y: number };
  } | null>(null);
  const [editingServer, setEditingServer] = useState<ServerWithRole | null>(null);
  const [deletingServer, setDeletingServer] = useState<ServerWithRole | null>(null);

  const servers = useServerStore((state) => state.servers);
  const activeServerId = useServerStore((state) => state.activeServerId);
  const setActiveServer = useServerStore((state) => state.setActiveServer);
  const activeServer = servers.find((s) => s.id === activeServerId) || null;

  const handleCreateSuccess = (server: ServerWithRole) => {
    setActiveServer(server.id);
  };

  const handleContextMenu = (server: ServerWithRole, position: { x: number; y: number }) => {
    setContextMenu({ server, position });
  };

  const handleEditServer = (server: ServerWithRole) => {
    setContextMenu(null);
    setEditingServer(server);
  };

  const handleDeleteServer = (server: ServerWithRole) => {
    setContextMenu(null);
    setDeletingServer(server);
  };

  return (
    <div className="view-container main-view">
      <div className="sidebar">
        <ServerList
          onOpenCreateModal={() => setIsCreateModalOpen(true)}
          onContextMenu={handleContextMenu}
        />
      </div>

      <div className="content">
        <div className="channels-sidebar">
          <h3>{activeServer ? activeServer.name : 'Channels'}</h3>
          <p className="placeholder-text">
            {activeServer ? 'No channels yet' : 'Select a server'}
          </p>
        </div>
        <div className="main-content">
          {activeServer ? (
            <>
              <h2>{activeServer.name}</h2>
              <p className="server-role-badge">
                Role: <span className={`role-text role-${activeServer.role}`}>{activeServer.role}</span>
              </p>
            </>
          ) : (
            <>
              <h2>Welcome to Concord</h2>
              <p>Privacy-first, self-hostable voice communication.</p>
            </>
          )}
        </div>
      </div>

      <CreateServerModal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        onSuccess={handleCreateSuccess}
      />

      {contextMenu && (
        <ServerContextMenu
          server={contextMenu.server}
          position={contextMenu.position}
          onClose={() => setContextMenu(null)}
          onEditServer={handleEditServer}
          onDeleteServer={handleDeleteServer}
        />
      )}

      {editingServer && (
        <ServerSettingsModal
          isOpen={!!editingServer}
          server={editingServer}
          onClose={() => setEditingServer(null)}
        />
      )}

      {deletingServer && (
        <DeleteServerModal
          isOpen={!!deletingServer}
          server={deletingServer}
          onClose={() => setDeletingServer(null)}
        />
      )}
    </div>
  );
};

export default MainView;
