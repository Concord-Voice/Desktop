import React, { useEffect, useRef } from 'react';
import { Hash, Volume2, Pin } from 'lucide-react';
import { useUnreadStore } from '../../stores/unreadStore';
import { useServerStore } from '../../stores/serverStore';
import { apiFetch } from '../../services/apiClient';
import { Channel } from '../../types/chat';
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
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  // Adjust position if menu would overflow viewport
  useEffect(() => {
    if (menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect();
      const viewportHeight = window.innerHeight;
      const viewportWidth = window.innerWidth;

      if (rect.bottom > viewportHeight) {
        menuRef.current.style.top = `${position.y - rect.height}px`;
      }
      if (rect.right > viewportWidth) {
        menuRef.current.style.left = `${position.x - rect.width}px`;
      }
    }
  }, [position]);

  // Owner and admin can edit/delete channels
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

  return (
    <div className="context-menu-overlay">
      <div
        ref={menuRef}
        className="context-menu channel-context-menu"
        style={{ top: position.y, left: position.x }}
      >
        {/* Channel info header */}
        <div className="context-menu-header">
          <span className="channel-context-type-icon">
            {getChannelTypeIcon(channel.type)}
          </span>
          {channel.emoji && (
            <span className="channel-context-emoji">{channel.emoji}</span>
          )}
          <span className="channel-context-name">{channel.name}</span>
        </div>

        <div className="context-menu-divider" />

        {/* Mark as Read */}
        <button
          className="context-menu-item"
          onClick={() => {
            useUnreadStore.getState().clearUnread(channel.id);
            apiFetch(`/api/v1/channels/${channel.id}/read`, { method: 'POST' }).catch(() => {});
            // Clear server dot if no more unreads
            const { unreadCounts } = useUnreadStore.getState();
            if (unreadCounts.size === 0) {
              const activeServerId = useServerStore.getState().activeServerId;
              if (activeServerId) {
                useUnreadStore.getState().clearServerUnread(activeServerId);
              }
            }
            onClose();
          }}
        >
          <span>Mark as Read</span>
        </button>

        {/* Edit option */}
        {canEdit && (
          <button
            className="context-menu-item"
            onClick={() => {
              onEditChannel(channel);
              onClose();
            }}
          >
            <span>Edit Channel</span>
          </button>
        )}

        {/* Delete option */}
        {canDelete && (
          <button
            className="context-menu-item danger"
            onClick={() => {
              onDeleteChannel(channel);
              onClose();
            }}
          >
            <span>Delete Channel</span>
          </button>
        )}

        {/* "Mark as Read" is always available, so no empty-state needed */}
      </div>
    </div>
  );
};

export default ChannelContextMenu;
