import React, { useEffect, useRef, useMemo } from 'react';
import { Hash, Volume2, Pin, Lock, Mic, MicOff, ChevronDown, ChevronRight, MessageSquare } from 'lucide-react';
import { useChannelStore } from '../../stores/channelStore';
import { useServerStore } from '../../stores/serverStore';
import { useUnreadStore } from '../../stores/unreadStore';
import { useVoiceStore, type ChannelVoiceMember } from '../../stores/voiceStore';
import { apiFetch } from '../../services/apiClient';
import { Channel, ChannelGroup } from '../../types/chat';
import './ChannelList.css';

interface ChannelListProps {
  onContextMenu: (channel: Channel, position: { x: number; y: number }) => void;
}

const ChannelList: React.FC<ChannelListProps> = ({ onContextMenu }) => {
  const activeServerId = useServerStore((state) => state.activeServerId);
  const channels = useChannelStore((state) => state.channels);
  const channelGroups = useChannelStore((state) => state.channelGroups);
  const collapsedGroups = useChannelStore((state) => state.collapsedGroups);
  const toggleGroupCollapsed = useChannelStore((state) => state.toggleGroupCollapsed);
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
  const channelVoiceMembers = useVoiceStore((s) => s.channelVoiceMembers);
  const setChannelVoiceMembers = useVoiceStore((s) => s.setChannelVoiceMembers);
  const setServerVoiceCount = useVoiceStore((s) => s.setServerVoiceCount);
  const clearAllChannelVoiceMembers = useVoiceStore((s) => s.clearAllChannelVoiceMembers);
  const fetchedServerRef = useRef<string | null>(null);

  // Fetch channels when active server changes
  useEffect(() => {
    if (activeServerId) {
      fetchChannels(activeServerId);
    } else {
      clearChannels();
    }
  }, [activeServerId, fetchChannels, clearChannels]);

  // Fetch voice participants for all voice channels when channel list loads
  useEffect(() => {
    const voiceChans = channels.filter((c) => c.type === 'voice');
    if (voiceChans.length === 0 || !activeServerId) return;
    // Only fetch once per server switch
    if (fetchedServerRef.current === activeServerId) return;
    fetchedServerRef.current = activeServerId;

    let totalVoiceCount = 0;
    const fetchAll = voiceChans.map(async (channel) => {
      try {
        const res = await apiFetch(`/api/v1/channels/${channel.id}/voice/participants`);
        if (!res.ok) return 0;
        const data = await res.json();
        const members: ChannelVoiceMember[] = (data.participants || []).map(
          (p: { user_id: string; username: string; display_name?: string; avatar_url?: string; is_muted?: boolean }) => ({
            userId: p.user_id,
            username: p.username,
            displayName: p.display_name,
            avatarUrl: p.avatar_url,
            isMuted: p.is_muted || false,
          }),
        );
        if (members.length > 0) {
          setChannelVoiceMembers(channel.id, members);
        }
        return members.length;
      } catch {
        // Non-critical — voice participants just won't show
        return 0;
      }
    });
    Promise.all(fetchAll).then((counts) => {
      totalVoiceCount = counts.reduce((sum, c) => sum + c, 0);
      if (activeServerId) setServerVoiceCount(activeServerId, totalVoiceCount);
    });
  }, [channels, activeServerId, setChannelVoiceMembers, setServerVoiceCount]);

  // Clear voice members when server changes
  useEffect(() => {
    return () => {
      clearAllChannelVoiceMembers();
      fetchedServerRef.current = null;
    };
  }, [activeServerId, clearAllChannelVoiceMembers]);

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
    // clearUnread + read mark handled by useEffect([activeChannelId]) above
  };

  // Build grouped channel structure: groups sorted by position, channels within groups sorted by position
  // Filter out linked text channels — they render inline below their parent voice channel
  const groupedChannels = useMemo(() => {
    const nonLinked = channels.filter((c) => !c.linked_voice_channel_id);

    // Sort groups by position
    const sortedGroups = [...channelGroups].sort((a, b) => a.position - b.position);

    // Map channels into their groups
    const grouped: { group: ChannelGroup | null; channels: Channel[] }[] = sortedGroups.map((g) => ({
      group: g,
      channels: nonLinked
        .filter((c) => c.group_id === g.id)
        .sort((a, b) => a.position - b.position),
    }));

    // Uncategorized channels (no group_id) go at the bottom
    const uncategorized = nonLinked
      .filter((c) => !c.group_id)
      .sort((a, b) => a.position - b.position);
    if (uncategorized.length > 0) {
      grouped.push({ group: null, channels: uncategorized });
    }

    return grouped;
  }, [channels, channelGroups]);

  // Map voice channel ID → linked text channel (for inline rendering)
  const linkedTextByVoice = useMemo(() => {
    const map = new Map<string, Channel>();
    for (const c of channels) {
      if (c.linked_voice_channel_id) {
        map.set(c.linked_voice_channel_id, c);
      }
    }
    return map;
  }, [channels]);

  const renderChannelItem = (channel: Channel) => {
    const isActive = channel.id === activeChannelId;
    const unread = unreadCounts.get(channel.id) || 0;
    const isVoiceConnected =
      channel.type === 'voice' &&
      channel.id === voiceChannelId &&
      voiceConnectionState === 'connected';

    // For voice channels: use detailed voiceParticipants if we're connected to this channel,
    // otherwise use channelVoiceMembers from the server-wide WS feed / REST fetch
    let voiceMembers: Array<{
      userId: string;
      displayName?: string;
      username: string;
      isMuted: boolean;
      isSpeaking?: boolean;
    }> = [];

    if (channel.type === 'voice') {
      if (isVoiceConnected) {
        voiceMembers = Object.values(voiceParticipants).map((p) => ({
          userId: p.userId,
          displayName: p.displayName,
          username: p.username,
          isMuted: p.isMuted,
          isSpeaking: p.isSpeaking,
        }));
      } else {
        voiceMembers = (channelVoiceMembers[channel.id] || []).map((m) => ({
          userId: m.userId,
          displayName: m.displayName,
          username: m.username,
          isMuted: m.isMuted,
          isSpeaking: false,
        }));
      }
    }

    // Check if this voice channel has a linked text chat that should be shown
    const linkedText = channel.type === 'voice' ? linkedTextByVoice.get(channel.id) : null;
    const showLinkedText = linkedText && voiceChannelId === channel.id;
    const linkedTextUnread = linkedText ? (unreadCounts.get(linkedText.id) || 0) : 0;
    const isLinkedTextActive = linkedText?.id === activeChannelId;

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
        {/* Linked text chat — only visible when user is in this voice channel */}
        {showLinkedText && linkedText && (
          <div
            className={`channel-item channel-item--voice-text ${isLinkedTextActive ? 'active' : ''} ${linkedTextUnread > 0 ? 'has-unread' : ''}`}
            onClick={() => handleChannelClick(linkedText)}
            title={`${channel.name} Text Chat`}
          >
            <span className="channel-type-icon"><MessageSquare size={14} /></span>
            <span className="channel-name">{channel.name} Text Chat</span>
            {linkedTextUnread > 0 && !isLinkedTextActive && (
              <span className="channel-unread-badge">{linkedTextUnread > 99 ? '99+' : linkedTextUnread}</span>
            )}
          </div>
        )}
        {voiceMembers.length > 0 && (
          <div className="voice-channel-participants">
            {voiceMembers.map((p) => (
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

      {/* Dynamic Channel Groups */}
      {channels.length > 0 && (
        <>
          {groupedChannels.map(({ group, channels: groupChannels }) => {
            if (groupChannels.length === 0) return null;

            const groupId = group?.id ?? '__uncategorized';
            const isCollapsed = group ? collapsedGroups.includes(group.id) : false;
            const groupName = group?.name ?? 'Uncategorized';

            // Count unreads in collapsed group
            const groupUnreadCount = isCollapsed
              ? groupChannels.reduce((sum, c) => sum + (unreadCounts.get(c.id) || 0), 0)
              : 0;

            return (
              <div key={groupId} className="channel-group">
                <div
                  className={`channel-group-header ${group ? 'channel-group-header--collapsible' : ''}`}
                  onClick={group ? () => toggleGroupCollapsed(group.id) : undefined}
                >
                  {group && (
                    <span className="channel-group-header__chevron">
                      {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                    </span>
                  )}
                  <span>{groupName.toUpperCase()}</span>
                  {isCollapsed && groupUnreadCount > 0 && (
                    <span className="channel-group-header__count">
                      {groupUnreadCount > 99 ? '99+' : groupUnreadCount}
                    </span>
                  )}
                </div>
                {!isCollapsed && groupChannels.map(renderChannelItem)}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
};

export default ChannelList;
