import { useState } from 'react';
import AppLayout from '../Layout/AppLayout';
import ServerBar from '../Layout/ServerBar';
import FolderBar from '../Layout/FolderBar';
import ChannelPanel from '../Layout/ChannelPanel';
import ConversationList from './ConversationList';
import DMChatArea from './DMChatArea';
import FriendsFlexSpace from './FriendsFlexSpace';
import UserPanel from '../User/UserPanel';
import PersistentVoiceBar from '../Voice/PersistentVoiceBar';
import ServerActionModal from '../Servers/ServerActionModal';
import CreateServerModal from '../Servers/CreateServerModal';
import JoinServerModal from '../Servers/JoinServerModal';
import ServerContextMenu from '../Servers/ServerContextMenu';
import { useLayoutStore } from '../../stores/layoutStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { ServerWithRole } from '../../types/server';

/** Mock thread names — keyed by conversation ID for header display */
const THREAD_NAMES: Record<string, string> = {
  'conv-1': 'Alice Chen',
  'conv-2': 'Project Alpha',
  'conv-3': 'Jordan Rivera',
  'conv-4': 'Sam Patel',
};

const DirectMessagesView: React.FC = () => {
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);

  const channelPanelPinned = useLayoutStore((s) => s.channelPanelPinned);
  const voiceActiveChannelId = useVoiceStore((s) => s.activeChannelId);
  const voiceConnectionState = useVoiceStore((s) => s.connectionState);
  const isInVoice = !!(voiceActiveChannelId && voiceConnectionState === 'connected');

  // DM page currently has no real MessageInput, so floating avatar always shows
  // when channel panel is unpinned. When DM messaging is implemented with MessageInput,
  // this condition should also check for that.
  const showFloatingAvatar = !channelPanelPinned;

  // Server modals (triggered by ServerBar add button or stale server placeholder)
  const [isServerActionModalOpen, setIsServerActionModalOpen] = useState(false);
  const [isCreateServerModalOpen, setIsCreateServerModalOpen] = useState(false);
  const [isJoinServerModalOpen, setIsJoinServerModalOpen] = useState(false);

  // Server context menu
  const [contextMenu, setContextMenu] = useState<{
    server: ServerWithRole;
    position: { x: number; y: number };
  } | null>(null);

  const handleServerContextMenu = (
    server: ServerWithRole,
    position: { x: number; y: number }
  ) => {
    setContextMenu({ server, position });
  };

  const handleCreateServerSuccess = () => {
    setIsCreateServerModalOpen(false);
    setIsJoinServerModalOpen(false);
  };

  const channelHeader = (
    <span style={{ fontWeight: 600, fontSize: 'calc(14px * var(--font-scale, 1))' }}>
      Direct Messages
    </span>
  );

  return (
    <div className="view-container main-view">
      <AppLayout
        serverBar={
          <ServerBar
            onOpenActionModal={() => setIsServerActionModalOpen(true)}
            onContextMenu={handleServerContextMenu}
          />
        }
        folderBar={<FolderBar />}
        channelPanel={
          <ChannelPanel header={channelHeader}>
            <ConversationList
              selectedThreadId={selectedThreadId}
              onSelectThread={setSelectedThreadId}
            />
          </ChannelPanel>
        }
        chatArea={
          <div className="main-content" data-has-persistent-bar={isInVoice || undefined}>
            <DMChatArea
              selectedThreadId={selectedThreadId}
              threadName={selectedThreadId ? THREAD_NAMES[selectedThreadId] : undefined}
            />
            {isInVoice && <PersistentVoiceBar />}
            {showFloatingAvatar && (
              <div className="floating-user-avatar">
                <UserPanel compact />
              </div>
            )}
          </div>
        }
        memberSpace={<FriendsFlexSpace />}
        forceMemberExpanded
      />

      {/* Server management modals */}
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

      {/* Server context menu */}
      {contextMenu && (
        <ServerContextMenu
          server={contextMenu.server}
          position={contextMenu.position}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
};

export default DirectMessagesView;
