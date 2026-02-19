import React, { useEffect } from 'react';
import { Hash, Volume2, Pin } from 'lucide-react';
import { useChannelStore } from '../../stores/channelStore';
import { useServerStore } from '../../stores/serverStore';
import { useUnreadStore } from '../../stores/unreadStore';
import { Channel } from '../../types/chat';
import './ChannelList.css';

interface ChannelListProps {
  onOpenCreateModal: () => void;
  onContextMenu: (channel: Channel, position: { x: number; y: number }) => void;
}

const ChannelList: React.FC<ChannelListProps> = ({
  onOpenCreateModal,
  onContextMenu,
}) => {
  const activeServerId = useServerStore((state) => state.activeServerId);
  const channels = useChannelStore((state) => state.channels);
  const activeChannelId = useChannelStore((state) => state.activeChannelId);
  const isLoading = useChannelStore((state) => state.isLoading);
  const error = useChannelStore((state) => state.error);
  const fetchChannels = useChannelStore((state) => state.fetchChannels);
  const setActiveChannel = useChannelStore((state) => state.setActiveChannel);
  const clearChannels = useChannelStore((state) => state.clearChannels);
  const unreadCounts = useUnreadStore((state) => state.unreadCounts);
  const clearUnread = useUnreadStore((state) => state.clearUnread);

  // Fetch channels when active server changes
  useEffect(() => {
    if (activeServerId) {
      fetchChannels(activeServerId);
    } else {
      clearChannels();
    }
  }, [activeServerId, fetchChannels, clearChannels]);

  const handleContextMenu = (e: React.MouseEvent, channel: Channel) => {
    e.preventDefault();
    onContextMenu(channel, { x: e.clientX, y: e.clientY });
  };

  const handleChannelClick = (channel: Channel) => {
    setActiveChannel(channel.id);
    clearUnread(channel.id);
  };

  // Group channels by type
  const textChannels = channels.filter((c) => c.type === 'text');
  const voiceChannels = channels.filter((c) => c.type === 'voice');
  const bulletinChannels = channels.filter((c) => c.type === 'bulletin');

  const renderChannelItem = (channel: Channel) => {
    const isActive = channel.id === activeChannelId;
    const unread = unreadCounts.get(channel.id) || 0;
    return (
      <div
        key={channel.id}
        className={`channel-item ${isActive ? 'active' : ''} ${unread > 0 ? 'has-unread' : ''}`}
        onClick={() => handleChannelClick(channel)}
        onContextMenu={(e) => handleContextMenu(e, channel)}
        title={channel.name}
      >
        <span className="channel-type-icon">
          {getChannelTypeIcon(channel.type)}
        </span>
        {channel.emoji && (
          <span className="channel-custom-emoji">{channel.emoji}</span>
        )}
        <span className="channel-name">{channel.name}</span>
        {unread > 0 && !isActive && (
          <span className="channel-unread-badge">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </div>
    );
  };

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

  // No server selected
  if (!activeServerId) {
    return (
      <div className="channel-list">
        <div className="channel-list-empty">
          <p>Select a server to view channels</p>
        </div>
      </div>
    );
  }

  return (
    <div className="channel-list">
      {/* Create Channel Button */}
      <div className="channel-list-header">
        <button
          className="create-channel-btn"
          onClick={onOpenCreateModal}
          title="Create Channel"
        >
          + New Channel
        </button>
      </div>

      {/* Loading State */}
      {isLoading && channels.length === 0 && (
        <div className="channel-list-skeletons">
          <div className="channel-skeleton" />
          <div className="channel-skeleton" />
          <div className="channel-skeleton" />
        </div>
      )}

      {/* Error State */}
      {error && channels.length === 0 && !isLoading && (
        <div className="channel-list-error">
          <p>{error}</p>
          <button
            onClick={() =>
              activeServerId && fetchChannels(activeServerId)
            }
            className="retry-btn"
          >
            Retry
          </button>
        </div>
      )}

      {/* Empty State */}
      {!isLoading && !error && channels.length === 0 && (
        <div className="channel-list-empty">
          <p>No channels yet</p>
          <p className="empty-hint">Click "+ New Channel" to create one</p>
        </div>
      )}

      {/* Channel Groups */}
      {channels.length > 0 && (
        <>
          {/* Bulletin Channels */}
          {bulletinChannels.length > 0 && (
            <div className="channel-group">
              <div className="channel-group-header">
                <span>BULLETINS</span>
              </div>
              {bulletinChannels.map(renderChannelItem)}
            </div>
          )}

          {/* Text Channels */}
          {textChannels.length > 0 && (
            <div className="channel-group">
              <div className="channel-group-header">
                <span>TEXT CHANNELS</span>
              </div>
              {textChannels.map(renderChannelItem)}
            </div>
          )}

          {/* Voice Channels */}
          {voiceChannels.length > 0 && (
            <div className="channel-group">
              <div className="channel-group-header">
                <span>VOICE CHANNELS</span>
              </div>
              {voiceChannels.map(renderChannelItem)}
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default ChannelList;
