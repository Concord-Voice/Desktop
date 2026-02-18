import React, { useState } from 'react';
import ServerList from '../Servers/ServerList';
import ServerContextMenu from '../Servers/ServerContextMenu';
import ServerSettingsModal from '../Servers/ServerSettingsModal';
import DeleteServerModal from '../Servers/DeleteServerModal';
import CreateServerModal from '../Servers/CreateServerModal';
import ChannelList from '../Channels/ChannelList';
import ChannelContextMenu from '../Channels/ChannelContextMenu';
import CreateChannelModal from '../Channels/CreateChannelModal';
import EditChannelModal from '../Channels/EditChannelModal';
import ConnectionStatus from '../ConnectionStatus/ConnectionStatus';
import MemberList from '../Members/MemberList';
import UserPanel from '../User/UserPanel';
import { useServerStore } from '../../stores/serverStore';
import { useChannelStore } from '../../stores/channelStore';
import { ServerWithRole } from '../../types/server';
import { Channel } from '../../types/chat';
import './MainView.css';

const MainView: React.FC = () => {
  const [isCreateServerModalOpen, setIsCreateServerModalOpen] = useState(false);
  const [isCreateChannelModalOpen, setIsCreateChannelModalOpen] = useState(false);
  const [serverContextMenu, setServerContextMenu] = useState<{
    server: ServerWithRole;
    position: { x: number; y: number };
  } | null>(null);
  const [channelContextMenu, setChannelContextMenu] = useState<{
    channel: Channel;
    position: { x: number; y: number };
  } | null>(null);
  const [editingServer, setEditingServer] = useState<ServerWithRole | null>(null);
  const [deletingServer, setDeletingServer] = useState<ServerWithRole | null>(null);
  const [editingChannel, setEditingChannel] = useState<Channel | null>(null);
  const [deletingChannel, setDeletingChannel] = useState<Channel | null>(null);

  const servers = useServerStore((state) => state.servers);
  const activeServerId = useServerStore((state) => state.activeServerId);
  const setActiveServer = useServerStore((state) => state.setActiveServer);
  const activeServer = servers.find((s) => s.id === activeServerId) || null;
  const setActiveChannel = useChannelStore((state) => state.setActiveChannel);

  const handleCreateServerSuccess = (server: ServerWithRole) => {
    setActiveServer(server.id);
  };

  const handleCreateChannelSuccess = (channel: Channel) => {
    setActiveChannel(channel.id);
  };

  const handleServerContextMenu = (server: ServerWithRole, position: { x: number; y: number }) => {
    setServerContextMenu({ server, position });
  };

  const handleEditServer = (server: ServerWithRole) => {
    setServerContextMenu(null);
    setEditingServer(server);
  };

  const handleDeleteServer = (server: ServerWithRole) => {
    setServerContextMenu(null);
    setDeletingServer(server);
  };

  const handleChannelContextMenu = (channel: Channel, position: { x: number; y: number }) => {
    setChannelContextMenu({ channel, position });
  };

  const handleEditChannel = (channel: Channel) => {
    setChannelContextMenu(null);
    setEditingChannel(channel);
  };

  const handleDeleteChannel = (channel: Channel) => {
    setChannelContextMenu(null);
    setDeletingChannel(channel);
    // TODO: Open delete channel modal (Issue #16)
  };

  return (
    <div className="view-container main-view">
      <div className="sidebar">
        <div className="sidebar-servers">
          <ServerList
            onOpenCreateModal={() => setIsCreateServerModalOpen(true)}
            onContextMenu={handleServerContextMenu}
          />
        </div>
        <UserPanel />
      </div>

      <div className="content">
        <div className="channels-sidebar">
          <div className="channels-sidebar-header">
            <h3>{activeServer ? activeServer.name : 'Channels'}</h3>
            <ConnectionStatus />
          </div>
          <ChannelList
            onOpenCreateModal={() => setIsCreateChannelModalOpen(true)}
            onContextMenu={handleChannelContextMenu}
          />
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
        {activeServer && <MemberList />}
      </div>

      <CreateServerModal
        isOpen={isCreateServerModalOpen}
        onClose={() => setIsCreateServerModalOpen(false)}
        onSuccess={handleCreateServerSuccess}
      />

      <CreateChannelModal
        isOpen={isCreateChannelModalOpen}
        onClose={() => setIsCreateChannelModalOpen(false)}
        onSuccess={handleCreateChannelSuccess}
      />

      {serverContextMenu && (
        <ServerContextMenu
          server={serverContextMenu.server}
          position={serverContextMenu.position}
          onClose={() => setServerContextMenu(null)}
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

      {channelContextMenu && activeServer && (
        <ChannelContextMenu
          channel={channelContextMenu.channel}
          position={channelContextMenu.position}
          userRole={activeServer.role}
          onClose={() => setChannelContextMenu(null)}
          onEditChannel={handleEditChannel}
          onDeleteChannel={handleDeleteChannel}
        />
      )}

      {editingChannel && (
        <EditChannelModal
          isOpen={!!editingChannel}
          channel={editingChannel}
          onClose={() => setEditingChannel(null)}
        />
      )}
    </div>
  );
};

export default MainView;
