import React, { useEffect, useRef } from 'react';
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

  const getChannelIcon = (type: Channel['type']) => {
    switch (type) {
      case 'text':
        return '#';
      case 'voice':
        return '🔊';
      case 'bulletin':
        return '📢';
      default:
        return '#';
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
          <span className="channel-context-icon">{getChannelIcon(channel.type)}</span>
          <span className="channel-context-name">{channel.name}</span>
        </div>

        <div className="context-menu-divider" />

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

        {!canEdit && !canDelete && (
          <div className="context-menu-item disabled">
            <span>No actions available</span>
          </div>
        )}
      </div>
    </div>
  );
};

export default ChannelContextMenu;
