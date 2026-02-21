import React, { useState } from 'react';
import { Hash, Volume2, Pin } from 'lucide-react';
import { useUnreadStore } from '../../stores/unreadStore';
import { useServerStore } from '../../stores/serverStore';
import { apiFetch } from '../../services/apiClient';
import { Channel } from '../../types/chat';
import ContextMenu from '../ui/ContextMenu';
import './ChannelContextMenu.css';

interface ChannelContextMenuProps {
  channel: Channel;
  position: { x: number; y: number };
  userRole: 'owner' | 'admin' | 'member';
  onClose: () => void;
  onEditChannel: (channel: Channel) => void;
  onDeleteChannel: (channel: Channel) => void;
}

const ChannelContextMenu: React.FC<ChannelContextMenuProps> = ({
  channel,
  position,
  userRole,
  onClose,
  onEditChannel,
  onDeleteChannel,
}) => {
  const [copiedLink, setCopiedLink] = useState(false);
  const canEdit = userRole === 'owner' || userRole === 'admin';
  const canDelete = userRole === 'owner' || userRole === 'admin';

  const getChannelTypeIcon = (type: Channel['type']) => {
    switch (type) {
      case 'text':
        return <Hash size={16} />;
      case 'voice':
        return <Volume2 size={16} />;
      case 'bulletin':
        return <Pin size={16} />;
      default:
        return <Hash size={16} />;
    }
  };

  const handleCopyLink = async () => {
    await navigator.clipboard.writeText(channel.id);
    setCopiedLink(true);
    setTimeout(() => onClose(), 800);
  };

  return (
    <ContextMenu position={position} onClose={onClose}>
      <ContextMenu.Header>
        <span className="channel-ctx-type-icon">{getChannelTypeIcon(channel.type)}</span>
        {channel.emoji && <span className="channel-ctx-emoji">{channel.emoji}</span>}
        <span className="channel-ctx-name">{channel.name}</span>
      </ContextMenu.Header>

      <ContextMenu.Separator />

      {/* Mark as Read */}
      <ContextMenu.Item
        icon={
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path
              d="M2 8.5l3.5 3.5L14 3"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        }
        label="Mark as Read"
        onClick={() => {
          useUnreadStore.getState().clearUnread(channel.id);
          apiFetch(`/api/v1/channels/${channel.id}/read`, { method: 'POST' }).catch(() => {});
          const { unreadCounts } = useUnreadStore.getState();
          if (unreadCounts.size === 0) {
            const activeServerId = useServerStore.getState().activeServerId;
            if (activeServerId) {
              useUnreadStore.getState().clearServerUnread(activeServerId);
            }
          }
          onClose();
        }}
      />

      {/* Mute Channel — disabled, no backend */}
      <ContextMenu.Item
        icon={
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path
              d="M12.5 5.5v-1a2 2 0 00-2-2h-5a2 2 0 00-2 2v5a2 2 0 002 2h1"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
            <path d="M2 2l12 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <path
              d="M9 8a3 3 0 013 3v1H8"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        }
        label="Mute Channel"
        disabled
        onClick={() => {}}
      />

      {/* Copy Link */}
      <ContextMenu.Item
        icon={
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M6.5 9.5l3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <path
              d="M9 10.5l1.5-1.5a2.83 2.83 0 000-4l0 0a2.83 2.83 0 00-4 0L5 6.5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
            <path
              d="M7 5.5L5.5 7a2.83 2.83 0 000 4l0 0a2.83 2.83 0 004 0L11 9.5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        }
        label={copiedLink ? 'Copied!' : 'Copy Link'}
        onClick={handleCopyLink}
      />

      {/* Edit Channel — admin/owner only */}
      {canEdit && (
        <>
          <ContextMenu.Separator />
          <ContextMenu.Item
            icon={
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path
                  d="M11.5 1.5l3 3L5 14H2v-3L11.5 1.5z"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            }
            label="Edit Channel"
            onClick={() => {
              onEditChannel(channel);
              onClose();
            }}
          />
        </>
      )}

      {/* Delete Channel — admin/owner only */}
      {canDelete && (
        <ContextMenu.Item
          icon={
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path
                d="M2 4h12M5.33 4V2.67a1.33 1.33 0 011.34-1.34h2.66a1.33 1.33 0 011.34 1.34V4M12.67 4v9.33a1.33 1.33 0 01-1.34 1.34H4.67a1.33 1.33 0 01-1.34-1.34V4"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          }
          label="Delete Channel"
          danger
          onClick={() => {
            onDeleteChannel(channel);
            onClose();
          }}
        />
      )}
    </ContextMenu>
  );
};

export default ChannelContextMenu;
