import React, { useState, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import ServerContextMenu from '../Servers/ServerContextMenu';
import ServerSettingsModal from '../Servers/ServerSettingsModal';
import DeleteServerModal from '../Servers/DeleteServerModal';
import LeaveServerModal from '../Servers/LeaveServerModal';
import CreateServerModal from '../Servers/CreateServerModal';
import ServerActionModal from '../Servers/ServerActionModal';
import JoinServerModal from '../Servers/JoinServerModal';
import InviteToServerModal from '../Servers/InviteToServerModal';
import ChannelList from '../Channels/ChannelList';
import ServerActionBar from '../Channels/ServerActionBar';
import ChannelContextMenu from '../Channels/ChannelContextMenu';
import ChannelListContextMenu from '../Channels/ChannelListContextMenu';
import CategoryContextMenu from '../Channels/CategoryContextMenu';
import CreateChannelModal from '../Channels/CreateChannelModal';
import CreateCategoryModal from '../Channels/CreateCategoryModal';
import EditChannelModal from '../Channels/EditChannelModal';
import EditCategoryModal from '../Channels/EditCategoryModal';
import DeleteChannelModal from '../Channels/DeleteChannelModal';
import DeleteCategoryModal from '../Channels/DeleteCategoryModal';
import ConnectionStatus from '../ConnectionStatus/ConnectionStatus';
import { ChatView } from '../Chat';
import VoiceView from '../Voice/VoiceView';
import PersistentVoiceBar from '../Voice/PersistentVoiceBar';
import VoiceTextChat from '../Voice/VoiceTextChat';
import UserPanel from '../User/UserPanel';
import { Lock, LockOpen } from 'lucide-react';
import { useVoiceStore } from '../../stores/voiceStore';
import { useLayoutStore } from '../../stores/layoutStore';

// New layout components
import AppLayout from '../Layout/AppLayout';
import ServerBar from '../Layout/ServerBar';
import FolderBar from '../Layout/FolderBar';
import ChannelPanel from '../Layout/ChannelPanel';
import MemberFlexSpace from '../Layout/MemberFlexSpace';

import { useServerStore } from '../../stores/serverStore';
import { useChannelStore } from '../../stores/channelStore';
import { useServerChannelSubscriptions } from '../../hooks/useServerChannelSubscriptions';
import { ServerWithRole } from '../../types/server';
import { Channel, ChannelGroup } from '../../types/chat';
import './MainView.css';

const MainView: React.FC = () => {
  // Subscribe to ALL channels in the active server for unread tracking
  useServerChannelSubscriptions();

  const [isServerActionModalOpen, setIsServerActionModalOpen] = useState(false);
  const [isCreateServerModalOpen, setIsCreateServerModalOpen] = useState(false);
  const [isJoinServerModalOpen, setIsJoinServerModalOpen] = useState(false);
  const [isCreateChannelModalOpen, setIsCreateChannelModalOpen] = useState(false);
  const [isCreateCategoryModalOpen, setIsCreateCategoryModalOpen] = useState(false);
  const [emptyContextMenu, setEmptyContextMenu] = useState<{ position: { x: number; y: number } } | null>(null);
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
  const [leavingServer, setLeavingServer] = useState<ServerWithRole | null>(null);
  const [editingChannel, setEditingChannel] = useState<Channel | null>(null);
  const [deletingChannel, setDeletingChannel] = useState<Channel | null>(null);
  const [categoryContextMenu, setCategoryContextMenu] = useState<{
    group: ChannelGroup;
    position: { x: number; y: number };
  } | null>(null);
  const [editingCategory, setEditingCategory] = useState<ChannelGroup | null>(null);
  const [deletingCategory, setDeletingCategory] = useState<ChannelGroup | null>(null);
  const [invitingServer, setInvitingServer] = useState<ServerWithRole | null>(null);
  const [e2eeTooltipPos, setE2eeTooltipPos] = useState<{ top: number; left: number } | null>(null);
  const e2eeIndicatorRef = useRef<HTMLSpanElement>(null);

  const showE2eeTooltip = useCallback(() => {
    if (e2eeIndicatorRef.current) {
      const rect = e2eeIndicatorRef.current.getBoundingClientRect();
      const tooltipWidth = 240;
      const padding = 8;
      const top = rect.bottom + padding;

      const leftAligned = rect.right - tooltipWidth;
      if (leftAligned >= padding) {
        setE2eeTooltipPos({ top, left: leftAligned });
      } else {
        const rightAligned = rect.left;
        const maxLeft = window.innerWidth - tooltipWidth - padding;
        setE2eeTooltipPos({ top, left: Math.min(rightAligned, maxLeft) });
      }
    }
  }, []);
  const hideE2eeTooltip = useCallback(() => setE2eeTooltipPos(null), []);

  const servers = useServerStore((state) => state.servers);
  const activeServerId = useServerStore((state) => state.activeServerId);
  const setActiveServer = useServerStore((state) => state.setActiveServer);
  const activeServer = servers.find((s) => s.id === activeServerId) || null;
  const activeChannelId = useChannelStore((state) => state.activeChannelId);
  const channels = useChannelStore((state) => state.channels);
  const setActiveChannel = useChannelStore((state) => state.setActiveChannel);
  const activeChannel = channels.find((c) => c.id === activeChannelId);
  const voiceActiveChannelId = useVoiceStore((s) => s.activeChannelId);
  const voiceConnectionState = useVoiceStore((s) => s.connectionState);
  const voiceShowTextChat = useVoiceStore((s) => s.showVoiceTextChat);
  const voiceTextChatLayout = useVoiceStore((s) => s.voiceTextChatLayout);
  const voiceTextChatWidth = useVoiceStore((s) => s.voiceTextChatWidth);
  const setVoiceTextChatWidth = useVoiceStore((s) => s.setVoiceTextChatWidth);
  const voiceControlsPinned = useVoiceStore((s) => s.voiceControlsPinned);
  const channelPanelPinned = useLayoutStore((s) => s.channelPanelPinned);
  const getLinkedTextChannel = useChannelStore((s) => s.getLinkedTextChannel);

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

  const handleLeaveServer = (server: ServerWithRole) => {
    setServerContextMenu(null);
    setLeavingServer(server);
  };

  const handleChannelContextMenu = (channel: Channel, position: { x: number; y: number }) => {
    setChannelContextMenu({ channel, position });
  };

  const handleEditChannel = (channel: Channel) => {
    setChannelContextMenu(null);
    setEditingChannel(channel);
  };

  const handleCategoryContextMenu = (group: ChannelGroup, position: { x: number; y: number }) => {
    setCategoryContextMenu({ group, position });
  };

  // ─── Channel panel header content ───
  const channelHeader = (
    <div className="channel-header-info">
      <div className="channel-header-name-row">
        <h3>{activeServer ? activeServer.name : 'Channels'}</h3>
        {activeServer && (
          <span
            ref={e2eeIndicatorRef}
            className={`server-e2ee-indicator ${activeServer.e2ee_default ? 'encrypted' : 'unencrypted'}`}
            onMouseEnter={showE2eeTooltip}
            onMouseLeave={hideE2eeTooltip}
          >
            {activeServer.e2ee_default ? <Lock size={12} /> : <LockOpen size={12} />}
          </span>
        )}
      </div>
      <ConnectionStatus />
    </div>
  );

  // ─── Voice & layout detection ───
  const isInVoice = voiceActiveChannelId && voiceConnectionState === 'connected';
  const isViewingOwnVoiceChannel =
    activeChannel?.type === 'voice' && activeChannel.id === voiceActiveChannelId;
  const showPersistentBar = !!(isInVoice && !isViewingOwnVoiceChannel);

  // Vertical voice text chat panel — rendered as a side column in MainView
  // instead of inside PersistentVoiceBar
  const voiceLinkedText = voiceActiveChannelId ? getLinkedTextChannel(voiceActiveChannelId) : null;
  const showVerticalSideChat = !!(
    showPersistentBar &&
    voiceControlsPinned &&
    voiceShowTextChat &&
    voiceLinkedText &&
    voiceTextChatLayout === 'vertical'
  );

  const sideResizingRef = useRef(false);
  const mainContentRef = useRef<HTMLDivElement>(null);

  const handleSideChatResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      sideResizingRef.current = true;
      const startX = e.clientX;
      const startWidth = voiceTextChatWidth;

      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      const onMouseMove = (moveEvent: MouseEvent) => {
        if (!sideResizingRef.current || !mainContentRef.current) return;
        const rect = mainContentRef.current.getBoundingClientRect();
        const maxWidth = rect.width * 0.5;
        const delta = startX - moveEvent.clientX;
        const newWidth = Math.min(maxWidth, Math.max(250, startWidth + delta));
        setVoiceTextChatWidth(newWidth);
      };

      const onMouseUp = () => {
        sideResizingRef.current = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    },
    [voiceTextChatWidth, setVoiceTextChatWidth]
  );

  // Determine if any MessageInput (which renders compact UserPanel) is on screen.
  // VoiceTextChat contains a MessageInput that shows compact UserPanel when channel panel is unpinned.
  const voiceLinkedTextExists = !!voiceLinkedText;
  const voiceTextChatVisible = isInVoice && voiceShowTextChat && voiceLinkedTextExists && (
    isViewingOwnVoiceChannel || (showPersistentBar && voiceControlsPinned)
  );
  const hasVisibleMessageInput =
    (activeChannel?.type === 'text' && !!activeChannelId) || voiceTextChatVisible;
  const showFloatingAvatar = !channelPanelPinned && !hasVisibleMessageInput;

  // ─── Channel panel body content ───
  const channelBody = (
    <>
      {activeServer && (
        <ServerActionBar
          server={activeServer}
          onOpenCreateModal={() => setIsCreateChannelModalOpen(true)}
          onOpenCreateCategoryModal={() => setIsCreateCategoryModalOpen(true)}
        />
      )}
      <ChannelList
        onContextMenu={handleChannelContextMenu}
        onEmptyContextMenu={(pos) => setEmptyContextMenu({ position: pos })}
        onCategoryContextMenu={handleCategoryContextMenu}
      />
    </>
  );

  // ─── Chat area content ───
  const chatContent = (
    <div ref={mainContentRef} className="main-content" data-has-persistent-bar={showPersistentBar || undefined}>
      <div className={`main-content__body ${showVerticalSideChat ? 'main-content__body--with-side-chat' : ''}`}>
        <div className="main-content__primary">
          {activeServer && channels.length === 0 ? (
            <div className="main-content-placeholder">
              <div className="empty-server-graphic">
                <svg
                  width="48"
                  height="48"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="10" y1="10" x2="14" y2="10" />
                </svg>
              </div>
              <h2>This server appears empty.</h2>
              <p className="empty-server-hint">Add some channels to start chatting!</p>
            </div>
          ) : activeChannel?.type === 'voice' ? (
            <VoiceView channelId={activeChannel.id} channelName={activeChannel.name} />
          ) : activeChannelId ? (
            <ChatView />
          ) : (
            <div className="main-content-placeholder">
              {activeServer ? (
                <>
                  <h2>{activeServer.name}</h2>
                  <p className="empty-server-hint">Select a channel to start chatting.</p>
                </>
              ) : (
                <>
                  <h2>Welcome to Concord Voice</h2>
                  <p>Privacy-first, self-hostable voice communication.</p>
                </>
              )}
            </div>
          )}

          {/* Persistent voice controls bar — shown when in voice but viewing another channel */}
          {showPersistentBar && <PersistentVoiceBar />}
        </div>

        {/* Vertical voice text chat side panel */}
        {showVerticalSideChat && (
          <>
            <div className="main-content__side-resize" onMouseDown={handleSideChatResizeStart}>
              <div className="main-content__side-resize-grip" />
            </div>
            <div className="main-content__side-chat" style={{ width: voiceTextChatWidth }}>
              <VoiceTextChat />
            </div>
          </>
        )}
      </div>

      {/* Floating user avatar — shown when channel panel is unpinned and no message input visible */}
      {showFloatingAvatar && (
        <div className="floating-user-avatar">
          <UserPanel compact />
        </div>
      )}
    </div>
  );

  return (
    <div className="view-container main-view">
      <AppLayout
        forceChannelPin={!!activeServer && channels.length === 0}
        serverBar={
          <ServerBar
            onOpenActionModal={() => setIsServerActionModalOpen(true)}
            onContextMenu={handleServerContextMenu}
          />
        }
        folderBar={<FolderBar />}
        channelPanel={
          <ChannelPanel
            header={channelHeader}
            forcePin={!!activeServer && channels.length === 0}
          >
            {channelBody}
          </ChannelPanel>
        }
        chatArea={chatContent}
        memberSpace={<MemberFlexSpace />}
      />

      {/* ─── Modals (z-index overlays, unaffected by layout) ─── */}

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

      <CreateCategoryModal
        isOpen={isCreateCategoryModalOpen}
        onClose={() => setIsCreateCategoryModalOpen(false)}
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

      {leavingServer && (
        <LeaveServerModal
          isOpen={!!leavingServer}
          server={leavingServer}
          onClose={() => setLeavingServer(null)}
        />
      )}

      {channelContextMenu && activeServer && (
        <ChannelContextMenu
          channel={channelContextMenu.channel}
          position={channelContextMenu.position}
          userRole={activeServer.role}
          onClose={() => setChannelContextMenu(null)}
          onEditChannel={handleEditChannel}
          onDeleteChannel={(channel) => {
            setChannelContextMenu(null);
            setDeletingChannel(channel);
          }}
        />
      )}

      {emptyContextMenu && activeServer && (activeServer.role === 'owner' || activeServer.role === 'admin') && (
        <ChannelListContextMenu
          position={emptyContextMenu.position}
          onClose={() => setEmptyContextMenu(null)}
          onCreateChannel={() => { setEmptyContextMenu(null); setIsCreateChannelModalOpen(true); }}
          onCreateCategory={() => { setEmptyContextMenu(null); setIsCreateCategoryModalOpen(true); }}
        />
      )}

      {invitingServer && (
        <InviteToServerModal
          isOpen={!!invitingServer}
          server={invitingServer}
          onClose={() => setInvitingServer(null)}
        />
      )}

      {categoryContextMenu && activeServer && (activeServer.role === 'owner' || activeServer.role === 'admin') && (
        <CategoryContextMenu
          group={categoryContextMenu.group}
          position={categoryContextMenu.position}
          onClose={() => setCategoryContextMenu(null)}
          onEditCategory={(group) => {
            setCategoryContextMenu(null);
            setEditingCategory(group);
          }}
          onDeleteCategory={(group) => {
            setCategoryContextMenu(null);
            setDeletingCategory(group);
          }}
        />
      )}

      {editingChannel && (
        <EditChannelModal
          isOpen={!!editingChannel}
          channel={editingChannel}
          onClose={() => setEditingChannel(null)}
        />
      )}

      {deletingChannel && (
        <DeleteChannelModal
          isOpen={!!deletingChannel}
          channel={deletingChannel}
          onClose={() => setDeletingChannel(null)}
        />
      )}

      {editingCategory && (
        <EditCategoryModal
          isOpen={!!editingCategory}
          group={editingCategory}
          onClose={() => setEditingCategory(null)}
        />
      )}

      {deletingCategory && (
        <DeleteCategoryModal
          isOpen={!!deletingCategory}
          group={deletingCategory}
          onClose={() => setDeletingCategory(null)}
        />
      )}

      {/* E2EE tooltip — portaled to body to escape transform-based containing blocks */}
      {e2eeTooltipPos && activeServer && createPortal(
        <div
          className={`e2ee-tooltip visible ${activeServer.e2ee_default ? 'encrypted' : 'unencrypted'}`}
          style={{ top: e2eeTooltipPos.top, left: e2eeTooltipPos.left }}
        >
          <span className="e2ee-tooltip-header">
            {activeServer.e2ee_default ? <Lock size={11} /> : <LockOpen size={11} />}
            {activeServer.e2ee_default ? 'E2EE Enabled' : 'E2EE Disabled'}
          </span>
          <span className="e2ee-tooltip-body">
            {activeServer.e2ee_default
              ? 'End-to-End Encryption is enabled by default in this server. New channels are created with E2EE on.'
              : 'End-to-End Encryption is not enabled by default in this server. Channels may still enable E2EE individually.'}
          </span>
          <span className="e2ee-tooltip-hint">
            Always check the channel encryption status near the message box to verify E2EE.
          </span>
        </div>,
        document.body
      )}
    </div>
  );
};

export default MainView;
