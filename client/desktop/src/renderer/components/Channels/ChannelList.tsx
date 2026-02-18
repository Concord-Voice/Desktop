import React, { useEffect } from 'react';
import { useAuthStore } from '../../stores/authStore';
import { useChannelStore } from '../../stores/channelStore';
import { useServerStore } from '../../stores/serverStore';
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
  const accessToken = useAuthStore((state) => state.accessToken);
  const activeServerId = useServerStore((state) => state.activeServerId);
  const channels = useChannelStore((state) => state.channels);
  const activeChannelId = useChannelStore((state) => state.activeChannelId);
  const isLoading = useChannelStore((state) => state.isLoading);
  const error = useChannelStore((state) => state.error);
  const fetchChannels = useChannelStore((state) => state.fetchChannels);
  const setActiveChannel = useChannelStore((state) => state.setActiveChannel);
  const clearChannels = useChannelStore((state) => state.clearChannels);

  // Fetch channels when active server changes
  useEffect(() => {
    if (activeServerId && accessToken) {
      fetchChannels(activeServerId, accessToken);
    } else {
      clearChannels();
    }
  }, [activeServerId, accessToken, fetchChannels, clearChannels]);

  const handleContextMenu = (e: React.MouseEvent, channel: Channel) => {
    e.preventDefault();
    onContextMenu(channel, { x: e.clientX, y: e.clientY });
  };

  const handleChannelClick = (channel: Channel) => {
    setActiveChannel(channel.id);
  };

  // Group channels by type
  const textChannels = channels.filter((c) => c.type === 'text');
  const voiceChannels = channels.filter((c) => c.type === 'voice');
  const bulletinChannels = channels.filter((c) => c.type === 'bulletin');

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
              activeServerId && accessToken && fetchChannels(activeServerId, accessToken)
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
              {bulletinChannels.map((channel) => (
                <div
                  key={channel.id}
                  className={`channel-item ${
                    channel.id === activeChannelId ? 'active' : ''
                  }`}
                  onClick={() => handleChannelClick(channel)}
                  onContextMenu={(e) => handleContextMenu(e, channel)}
                  title={channel.name}
                >
                  <span className="channel-icon">
                    {getChannelIcon(channel.type)}
                  </span>
                  <span className="channel-name">{channel.name}</span>
                </div>
              ))}
            </div>
          )}

          {/* Text Channels */}
          {textChannels.length > 0 && (
            <div className="channel-group">
              <div className="channel-group-header">
                <span>TEXT CHANNELS</span>
              </div>
              {textChannels.map((channel) => (
                <div
                  key={channel.id}
                  className={`channel-item ${
                    channel.id === activeChannelId ? 'active' : ''
                  }`}
                  onClick={() => handleChannelClick(channel)}
                  onContextMenu={(e) => handleContextMenu(e, channel)}
                  title={channel.name}
                >
                  <span className="channel-icon">
                    {getChannelIcon(channel.type)}
                  </span>
                  <span className="channel-name">{channel.name}</span>
                </div>
              ))}
            </div>
          )}

          {/* Voice Channels */}
          {voiceChannels.length > 0 && (
            <div className="channel-group">
              <div className="channel-group-header">
                <span>VOICE CHANNELS</span>
              </div>
              {voiceChannels.map((channel) => (
                <div
                  key={channel.id}
                  className={`channel-item ${
                    channel.id === activeChannelId ? 'active' : ''
                  }`}
                  onClick={() => handleChannelClick(channel)}
                  onContextMenu={(e) => handleContextMenu(e, channel)}
                  title={channel.name}
                >
                  <span className="channel-icon">
                    {getChannelIcon(channel.type)}
                  </span>
                  <span className="channel-name">{channel.name}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default ChannelList;
