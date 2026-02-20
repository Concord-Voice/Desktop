import React, { useState } from 'react';
import ServerList from '../Servers/ServerList';
import ServerContextMenu from '../Servers/ServerContextMenu';
import ServerSettingsModal from '../Servers/ServerSettingsModal';
import DeleteServerModal from '../Servers/DeleteServerModal';
import CreateServerModal from '../Servers/CreateServerModal';
import ServerActionModal from '../Servers/ServerActionModal';
import JoinServerModal from '../Servers/JoinServerModal';
import InviteToServerModal from '../Servers/InviteToServerModal';
import ChannelList from '../Channels/ChannelList';
import ServerActionBar from '../Channels/ServerActionBar';
import ChannelContextMenu from '../Channels/ChannelContextMenu';
import CreateChannelModal from '../Channels/CreateChannelModal';
import EditChannelModal from '../Channels/EditChannelModal';
import ConnectionStatus from '../ConnectionStatus/ConnectionStatus';
import MemberList from '../Members/MemberList';
import UserPanel from '../User/UserPanel';
import { ChatView } from '../Chat';
import { useServerStore } from '../../stores/serverStore';
import { useChannelStore } from '../../stores/channelStore';
import { useUserStore } from '../../stores/userStore';
import { apiFetch } from '../../services/apiClient';
import { useServerChannelSubscriptions } from '../../hooks/useServerChannelSubscriptions';
import { useResizablePanel } from '../../hooks/useResizablePanel';
import { ServerWithRole } from '../../types/server';
import { Channel } from '../../types/chat';
import './MainView.css';

const MainView: React.FC = () => {
  // Subscribe to ALL channels in the active server for unread tracking
  useServerChannelSubscriptions();

  // Resizable sidebars
  const channelPanel = useResizablePanel({
    defaultWidth: 240, minWidth: 180, maxWidth: 400, side: 'left',
    storageKey: 'concord:channelSidebarWidth',
  });
  const memberPanel = useResizablePanel({
    defaultWidth: 220, minWidth: 160, maxWidth: 340, side: 'right',
    storageKey: 'concord:memberListWidth',
  });

  const [isServerActionModalOpen, setIsServerActionModalOpen] = useState(false);
  const [isCreateServerModalOpen, setIsCreateServerModalOpen] = useState(false);
  const [isJoinServerModalOpen, setIsJoinServerModalOpen] = useState(false);
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
  const [invitingServer, setInvitingServer] = useState<ServerWithRole | null>(null);

  const servers = useServerStore((state) => state.servers);
  const activeServerId = useServerStore((state) => state.activeServerId);
  const setActiveServer = useServerStore((state) => state.setActiveServer);
  const activeServer = servers.find((s) => s.id === activeServerId) || null;
  const activeChannelId = useChannelStore((state) => state.activeChannelId);
  const channels = useChannelStore((state) => state.channels);
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

  const handleInviteServer = (server: ServerWithRole) => {
    setServerContextMenu(null);
    setInvitingServer(server);
  };

  const handleLeaveServer = async (server: ServerWithRole) => {
    setServerContextMenu(null);
    const user = useUserStore.getState().user;
    if (!user) return;

    try {
      await apiFetch(`/api/v1/servers/${server.id}/members/${user.id}`, {
        method: 'DELETE',
      });
      useServerStore.getState().removeServer(server.id);
    } catch (error) {
      console.error('Failed to leave server:', error);
    }
  };

  const handleChannelContextMenu = (channel: Channel, position: { x: number; y: number }) => {
    setChannelContextMenu({ channel, position });
  };

  const handleEditChannel = (channel: Channel) => {
    setChannelContextMenu(null);
    setEditingChannel(channel);
  };

  return (
    <div className="view-container main-view">
      <div className="sidebar">
        <div className="sidebar-servers">
          <ServerList
            onOpenActionModal={() => setIsServerActionModalOpen(true)}
            onContextMenu={handleServerContextMenu}
          />
        </div>
        <UserPanel />
      </div>

      <div className="content">
        <div className="channels-sidebar" style={{ width: channelPanel.width }}>
          <div className="channels-sidebar-header">
            <h3>{activeServer ? activeServer.name : 'Channels'}</h3>
            <ConnectionStatus />
          </div>
          {activeServer && (
            <ServerActionBar
              server={activeServer}
              onOpenCreateModal={() => setIsCreateChannelModalOpen(true)}
            />
          )}
          <ChannelList
            onContextMenu={handleChannelContextMenu}
          />
        </div>
        <div className="resize-handle" onMouseDown={channelPanel.onMouseDown} />
        <div className="main-content">
          {activeChannelId ? (
            <ChatView />
          ) : (
            <div className="main-content-placeholder">
              {activeServer ? (
                <>
                  <h2>{activeServer.name}</h2>
                  {channels.length === 0 ? (
                    <p className="empty-server-hint">No channels yet — create one to get started.</p>
                  ) : (
                    <p className="empty-server-hint">Select a channel to start chatting.</p>
                  )}
                </>
              ) : (
                <>
                  <h2>Welcome to Concord</h2>
                  <p>Privacy-first, self-hostable voice communication.</p>
                </>
              )}
            </div>
          )}
        </div>
        {activeServer && (
          <>
            <div className="resize-handle" onMouseDown={memberPanel.onMouseDown} />
            <div className="member-list-container" style={{ width: memberPanel.width }}>
              <MemberList />
            </div>
          </>
        )}
      </div>

      <ServerActionModal
        isOpen={isServerActionModalOpen}
        onClose={() => setIsServerActionModalOpen(false)}
        onCreateServer={() => setIsCreateServerModalOpen(true)}
        onJoinServer={() => setIsJoinServerModalOpen(true)}
      />

      <CreateServerModal
        isOpen={isCreateServerModalOpen}
        onClose={() => setIsCreateServerModalOpen(false)}
        onSuccess={handleCreateServerSuccess}
      />

      <JoinServerModal
        isOpen={isJoinServerModalOpen}
        onClose={() => setIsJoinServerModalOpen(false)}
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
          onLeaveServer={handleLeaveServer}
          onInvite={handleInviteServer}
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
          onDeleteChannel={() => { /* TODO: Delete channel modal (Issue #16) */ }}
        />
      )}

      {invitingServer && (
        <InviteToServerModal
          isOpen={!!invitingServer}
          server={invitingServer}
          onClose={() => setInvitingServer(null)}
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
