import React, { useEffect, useRef, useMemo, useState, useCallback } from 'react';
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
  onEmptyContextMenu: (position: { x: number; y: number }) => void;
}

const ChannelList: React.FC<ChannelListProps> = ({ onContextMenu, onEmptyContextMenu }) => {
  const activeServerId = useServerStore((state) => state.activeServerId);
  const servers = useServerStore((state) => state.servers);
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
  const reorderChannels = useChannelStore((state) => state.reorderChannels);
  const updateChannelGroup = useChannelStore((state) => state.updateChannelGroup);
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

  // DnD state
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [draggingType, setDraggingType] = useState<'channel' | 'category' | null>(null);
  const [dragInsertPos, setDragInsertPos] = useState<{
    targetId: string;
    side: 'before' | 'after';
    targetType: 'channel' | 'category';
  } | null>(null);
  const lastInsertRef = useRef<typeof dragInsertPos>(null);
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const activeServer = servers.find((s) => s.id === activeServerId);
  const canReorder = activeServer?.role === 'owner' || activeServer?.role === 'admin';

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

  const handleEmptyContextMenu = (e: React.MouseEvent) => {
    // Only fire if clicking empty space (not a channel item or group header)
    if ((e.target as HTMLElement).closest('.channel-item, .channel-group-header')) return;
    e.preventDefault();
    onEmptyContextMenu({ x: e.clientX, y: e.clientY });
  };

  const handleChannelClick = (channel: Channel) => {
    setActiveChannel(channel.id);
    // clearUnread + read mark handled by useEffect([activeChannelId]) above
  };

  // ── Drag-and-drop handlers ──

  const handleDragStart = useCallback((e: React.DragEvent, id: string, type: 'channel' | 'category') => {
    if (!canReorder) return;
    e.dataTransfer.setData('application/concord-channel', JSON.stringify({ id, type }));
    e.dataTransfer.effectAllowed = 'move';
    setDraggingId(id);
    setDraggingType(type);

    // Create semi-transparent drag image
    const el = itemRefs.current.get(id);
    if (el) {
      const clone = el.cloneNode(true) as HTMLDivElement;
      const rect = el.getBoundingClientRect();
      Object.assign(clone.style, {
        position: 'fixed',
        top: '-9999px',
        left: '-9999px',
        width: `${rect.width}px`,
        opacity: '0.7',
        pointerEvents: 'none',
      });
      document.body.appendChild(clone);
      e.dataTransfer.setDragImage(clone, rect.width / 2, rect.height / 2);
      requestAnimationFrame(() => document.body.removeChild(clone));
    }
  }, [canReorder]);

  const handleDragOver = useCallback((e: React.DragEvent, targetId: string, targetType: 'channel' | 'category') => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';

    // Categories can only reorder among other categories, not drop onto channels
    if (draggingType === 'category' && targetType === 'channel') return;

    const el = itemRefs.current.get(targetId);
    if (!el) return;

    const rect = el.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const deadZone = rect.height * 0.25;

    let side: 'before' | 'after';
    if (e.clientY < midY - deadZone) {
      side = 'before';
    } else if (e.clientY > midY + deadZone) {
      side = 'after';
    } else {
      // In dead zone — keep last position or default to 'after'
      if (lastInsertRef.current?.targetId === targetId) return;
      side = 'after';
    }

    const newPos = { targetId, side, targetType };
    if (
      lastInsertRef.current?.targetId === targetId &&
      lastInsertRef.current?.side === side
    ) return;

    lastInsertRef.current = newPos;
    setDragInsertPos(newPos);
  }, [draggingType]);

  const handleDragEnd = useCallback(() => {
    setDraggingId(null);
    setDraggingType(null);
    setDragInsertPos(null);
    lastInsertRef.current = null;
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const insertPos = dragInsertPos;
    handleDragEnd();

    if (!insertPos || !activeServerId) return;

    let parsed: { id: string; type: string };
    try {
      parsed = JSON.parse(e.dataTransfer.getData('application/concord-channel'));
    } catch {
      return;
    }

    const { id: sourceId, type: sourceType } = parsed;
    if (sourceId === insertPos.targetId) return;

    if (sourceType === 'channel') {
      // Build flat list of all non-linked channels sorted by group then position
      const nonLinked = channels.filter((c) => !c.linked_voice_channel_id);
      const sortedGroups = [...channelGroups].sort((a, b) => a.position - b.position);

      // Determine target group and position
      const targetChannel = nonLinked.find((c) => c.id === insertPos.targetId);
      const targetGroup = insertPos.targetType === 'category'
        ? channelGroups.find((g) => g.id === insertPos.targetId)
        : null;

      let targetGroupId: string | null;
      if (targetGroup) {
        // Dropped on a category header — move into that category
        targetGroupId = targetGroup.id;
      } else if (targetChannel) {
        targetGroupId = targetChannel.group_id || null;
      } else {
        return;
      }

      // Get channels in the target group, sorted by position
      const groupChans = nonLinked
        .filter((c) => (targetGroupId ? c.group_id === targetGroupId : !c.group_id))
        .filter((c) => c.id !== sourceId)
        .sort((a, b) => a.position - b.position);

      // Find insert index
      let insertIdx: number;
      if (targetGroup) {
        // Dropped on category header — append at end
        insertIdx = groupChans.length;
      } else {
        const targetIdx = groupChans.findIndex((c) => c.id === insertPos.targetId);
        insertIdx = insertPos.side === 'after' ? targetIdx + 1 : targetIdx;
        if (insertIdx < 0) insertIdx = groupChans.length;
      }

      // Insert source channel
      const sourceChannel = nonLinked.find((c) => c.id === sourceId);
      if (!sourceChannel) return;
      groupChans.splice(insertIdx, 0, sourceChannel);

      // Build updates for this group
      const updates = groupChans.map((c, i) => ({
        channel_id: c.id,
        group_id: targetGroupId,
        position: i,
      }));

      // If source moved between groups, also reorder the old group
      const oldGroupId = sourceChannel.group_id || null;
      if (oldGroupId !== targetGroupId) {
        const oldGroupChans = nonLinked
          .filter((c) => (oldGroupId ? c.group_id === oldGroupId : !c.group_id))
          .filter((c) => c.id !== sourceId)
          .sort((a, b) => a.position - b.position);
        oldGroupChans.forEach((c, i) => {
          updates.push({ channel_id: c.id, group_id: oldGroupId, position: i });
        });
      }

      // Optimistic update + API call
      reorderChannels(updates);
      apiFetch(`/api/v1/servers/${activeServerId}/channels/reorder`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channels: updates }),
      }).catch(() => {
        // Revert: re-fetch channels on failure
        fetchChannels(activeServerId);
      });

    } else if (sourceType === 'category') {
      // Reorder categories
      const sorted = [...channelGroups].sort((a, b) => a.position - b.position);
      const filtered = sorted.filter((g) => g.id !== sourceId);
      const targetIdx = filtered.findIndex((g) => g.id === insertPos.targetId);
      if (targetIdx === -1) return;

      const insertIdx = insertPos.side === 'after' ? targetIdx + 1 : targetIdx;
      const sourceGroup = channelGroups.find((g) => g.id === sourceId);
      if (!sourceGroup) return;
      filtered.splice(insertIdx, 0, sourceGroup);

      // Update positions optimistically
      filtered.forEach((g, i) => {
        updateChannelGroup(g.id, { position: i });
      });

      // API calls to persist
      Promise.all(
        filtered.map((g, i) =>
          apiFetch(`/api/v1/servers/${activeServerId}/channel-groups/${g.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ position: i }),
          })
        )
      ).catch(() => {
        fetchChannels(activeServerId);
      });
    }
  }, [dragInsertPos, activeServerId, channels, channelGroups, reorderChannels, updateChannelGroup, fetchChannels, handleDragEnd]);

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

  const renderChannelItem = (channel: Channel, index: number, arr: Channel[], isGrouped: boolean) => {
    const isActive = channel.id === activeChannelId;
    const unread = unreadCounts.get(channel.id) || 0;
    const isVoiceConnected =
      channel.type === 'voice' &&
      channel.id === voiceChannelId &&
      voiceConnectionState === 'connected';
    const isLastInGroup = isGrouped && index === arr.length - 1;

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

    // Build class list for grouped hierarchy
    const itemClasses = [
      'channel-item',
      isActive ? 'active' : '',
      unread > 0 ? 'has-unread' : '',
      isGrouped ? 'channel-item--grouped' : '',
      isLastInGroup ? 'channel-item--grouped-last' : '',
    ].filter(Boolean).join(' ');

    const isDragging = draggingId === channel.id;
    const showGhostBefore = dragInsertPos?.targetId === channel.id && dragInsertPos.side === 'before';
    const showGhostAfter = dragInsertPos?.targetId === channel.id && dragInsertPos.side === 'after';

    return (
      <div key={channel.id} className={isGrouped ? 'channel-item-wrapper channel-item-wrapper--grouped' : 'channel-item-wrapper'}>
        {showGhostBefore && <div className="channel-drag-ghost" />}
        <div
          ref={(el) => { if (el) itemRefs.current.set(channel.id, el); else itemRefs.current.delete(channel.id); }}
          className={`${itemClasses} ${isDragging ? 'dragging' : ''}`}
          draggable={canReorder}
          onDragStart={(e) => handleDragStart(e, channel.id, 'channel')}
          onDragOver={(e) => handleDragOver(e, channel.id, 'channel')}
          onDrop={handleDrop}
          onDragEnd={handleDragEnd}
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
            className={`channel-item channel-item--voice-text ${isGrouped ? 'channel-item--voice-text-grouped' : ''} ${isLinkedTextActive ? 'active' : ''} ${linkedTextUnread > 0 ? 'has-unread' : ''}`}
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
          <div className={`voice-channel-participants ${isGrouped ? 'voice-channel-participants--grouped' : ''}`}>
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
        {showGhostAfter && <div className="channel-drag-ghost" />}
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
    <div className="channel-list" onContextMenu={handleEmptyContextMenu}>
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
          <p className="channel-list-empty-hint">Use "+ Add" above to create one</p>
        </div>
      )}

      {/* Dynamic Channel Groups */}
      {channels.length > 0 && (
        <>
          {groupedChannels.map(({ group, channels: groupChannels }) => {
            const groupId = group?.id ?? '__uncategorized';
            const isCollapsed = group ? collapsedGroups.includes(group.id) : false;

            // Uncategorized channels render at root level with no header
            if (!group) {
              if (groupChannels.length === 0) return null;
              return (
                <div key={groupId} className="channel-group channel-group--uncategorized">
                  {groupChannels.map((ch, i, arr) => renderChannelItem(ch, i, arr, false))}
                </div>
              );
            }

            // Count unreads in collapsed group (text channels only, exclude voice-linked text)
            const groupUnreadCount = isCollapsed
              ? groupChannels
                  .filter((c) => c.type !== 'voice' && !c.linked_voice_channel_id)
                  .reduce((sum, c) => sum + (unreadCounts.get(c.id) || 0), 0)
              : 0;

            // Stacked voice user avatars when collapsed
            const groupVoiceUsers = isCollapsed
              ? groupChannels
                  .filter((c) => c.type === 'voice')
                  .flatMap((c) => channelVoiceMembers[c.id] || [])
              : [];

            const isCategoryDragging = draggingId === group.id;
            const showCategoryGhostBefore = dragInsertPos?.targetId === group.id && dragInsertPos.side === 'before';
            const showCategoryGhostAfter = dragInsertPos?.targetId === group.id && dragInsertPos.side === 'after' && isCollapsed;
            const isCategoryDragOver = draggingType === 'channel' && dragInsertPos?.targetId === group.id && dragInsertPos.targetType === 'category';

            return (
              <div key={groupId} className="channel-group">
                {showCategoryGhostBefore && <div className="channel-drag-ghost" />}
                <div
                  ref={(el) => { if (el) itemRefs.current.set(group.id, el); else itemRefs.current.delete(group.id); }}
                  className={`channel-group-header channel-group-header--collapsible ${isCategoryDragging ? 'dragging' : ''} ${isCategoryDragOver ? 'drag-over' : ''}`}
                  draggable={canReorder}
                  onDragStart={(e) => handleDragStart(e, group.id, 'category')}
                  onDragOver={(e) => {
                    // If dragging a channel over a category, treat as "move into category"
                    if (draggingType === 'channel') {
                      e.preventDefault();
                      e.stopPropagation();
                      e.dataTransfer.dropEffect = 'move';
                      const newPos = { targetId: group.id, side: 'after' as const, targetType: 'category' as const };
                      lastInsertRef.current = newPos;
                      setDragInsertPos(newPos);
                    } else {
                      handleDragOver(e, group.id, 'category');
                    }
                  }}
                  onDrop={handleDrop}
                  onDragEnd={handleDragEnd}
                  onClick={() => toggleGroupCollapsed(group.id)}
                >
                  <span className="channel-group-header__chevron">
                    {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                  </span>
                  <span>{group.name.toUpperCase()}</span>
                  {isCollapsed && groupVoiceUsers.length > 0 && (
                    <div className="channel-group-header__voice-users">
                      {groupVoiceUsers.slice(0, 3).map((user) => (
                        <div key={user.userId} className="channel-group-header__avatar" title={user.displayName || user.username}>
                          {user.avatarUrl
                            ? <img src={user.avatarUrl} alt="" />
                            : <span>{(user.displayName || user.username).charAt(0).toUpperCase()}</span>}
                        </div>
                      ))}
                      {groupVoiceUsers.length > 3 && (
                        <span className="channel-group-header__avatar-overflow">
                          +{groupVoiceUsers.length - 3}
                        </span>
                      )}
                    </div>
                  )}
                  {isCollapsed && groupUnreadCount > 0 && (
                    <span className="channel-group-header__count">
                      {groupUnreadCount > 99 ? '99+' : groupUnreadCount}
                    </span>
                  )}
                </div>
                {!isCollapsed && groupChannels.map((ch, i, arr) => renderChannelItem(ch, i, arr, true))}
                {showCategoryGhostAfter && <div className="channel-drag-ghost" />}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
};

export default ChannelList;
