import React, { useEffect } from 'react';
import { Hash, Volume2, Pin, Lock, Mic, MicOff } from 'lucide-react';
import { useChannelStore } from '../../stores/channelStore';
import { useServerStore } from '../../stores/serverStore';
import { useUnreadStore } from '../../stores/unreadStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { apiFetch } from '../../services/apiClient';
import { Channel } from '../../types/chat';
import './ChannelList.css';

interface ChannelListProps {
  onContextMenu: (channel: Channel, position: { x: number; y: number }) => void;
}

const ChannelList: React.FC<ChannelListProps> = ({ onContextMenu }) => {
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
  const voiceChannelId = useVoiceStore((s) => s.activeChannelId);
  const voiceParticipants = useVoiceStore((s) => s.participants);
  const voiceConnectionState = useVoiceStore((s) => s.connectionState);

  // Fetch channels when active server changes
  useEffect(() => {
    if (activeServerId) {
      fetchChannels(activeServerId);
    } else {
      clearChannels();
    }
  }, [activeServerId, fetchChannels, clearChannels]);

  // Clear unread + mark as read whenever the active channel changes
  // (handles both manual clicks AND auto-focus from server switch)
  useEffect(() => {
    if (!activeChannelId) return;
    clearUnread(activeChannelId);
    apiFetch(`/api/v1/channels/${activeChannelId}/read`, { method: 'POST' }).catch(() => {});

    // If all channel unreads are now cleared, clear the server dot too
    const { unreadCounts: currentCounts } = useUnreadStore.getState();
    if (currentCounts.size === 0 && activeServerId) {
      useUnreadStore.getState().clearServerUnread(activeServerId);
    }
  }, [activeChannelId, activeServerId, clearUnread]);

  const handleContextMenu = (e: React.MouseEvent, channel: Channel) => {
    e.preventDefault();
    onContextMenu(channel, { x: e.clientX, y: e.clientY });
  };

  const handleChannelClick = (channel: Channel) => {
    setActiveChannel(channel.id);
    clearUnread(channel.id);
    // Mark as read on the server so unread counts persist across sessions
    apiFetch(`/api/v1/channels/${channel.id}/read`, { method: 'POST' }).catch(() => {});
  };

  // Group channels by type
  const textChannels = channels.filter((c) => c.type === 'text');
  const voiceChannels = channels.filter((c) => c.type === 'voice');
  const bulletinChannels = channels.filter((c) => c.type === 'bulletin');

  const renderChannelItem = (channel: Channel) => {
    const isActive = channel.id === activeChannelId;
    const unread = unreadCounts.get(channel.id) || 0;
    const isVoiceConnected =
      channel.type === 'voice' &&
      channel.id === voiceChannelId &&
      voiceConnectionState === 'connected';
    const participants = isVoiceConnected ? Object.values(voiceParticipants) : [];

    return (
      <div key={channel.id}>
        <div
          className={`channel-item ${isActive ? 'active' : ''} ${unread > 0 ? 'has-unread' : ''}`}
          onClick={() => handleChannelClick(channel)}
          onContextMenu={(e) => handleContextMenu(e, channel)}
          title={channel.name}
        >
          <span className="channel-type-icon">{getChannelTypeIcon(channel.type)}</span>
          {channel.emoji && <span className="channel-custom-emoji">{channel.emoji}</span>}
          <span className="channel-name">{channel.name}</span>
          {channel.is_encrypted && (
            <span className="channel-encrypted-icon" title="End-to-End Encrypted">
              <Lock size={12} />
            </span>
          )}
          {unread > 0 && !isActive && (
            <span className="channel-unread-badge">{unread > 99 ? '99+' : unread}</span>
          )}
        </div>
        {participants.length > 0 && (
          <div className="voice-channel-participants">
            {participants.map((p) => (
              <div
                key={p.userId}
                className={`voice-channel-participant ${p.isSpeaking ? 'speaking' : ''}`}
              >
                {p.isMuted ? <MicOff size={12} /> : <Mic size={12} />}
                <span className="voice-channel-participant-name">
                  {p.displayName || p.username}
                </span>
              </div>
            ))}
          </div>
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
            onClick={() => activeServerId && fetchChannels(activeServerId)}
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
          <p className="channel-list-empty-hint">Use "New Channel" above to create one</p>
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
