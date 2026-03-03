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
  onCategoryContextMenu: (group: ChannelGroup, position: { x: number; y: number }) => void;
}

const ChannelList: React.FC<ChannelListProps> = ({ onContextMenu, onEmptyContextMenu, onCategoryContextMenu }) => {
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
  const showVoiceTextChat = useVoiceStore((s) => s.showVoiceTextChat);
  const setShowVoiceTextChat = useVoiceStore((s) => s.setShowVoiceTextChat);
  const fetchedServerRef = useRef<string | null>(null);

  // DnD state
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [draggingType, setDraggingType] = useState<'channel' | 'category' | null>(null);
  const [dragInsertPos, setDragInsertPos] = useState<{
    targetId: string;
    side: 'before' | 'after';
    targetType: 'channel' | 'category' | 'gap';
  } | null>(null);
  const lastInsertRef = useRef<typeof dragInsertPos>(null);
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const activeServer = servers.find((s) => s.id === activeServerId);
  const canReorder = activeServer?.role === 'owner' || activeServer?.role === 'admin';

  // Fetch channels when active server changes.
  // Guard prevents StrictMode double-mount from firing duplicate HTTP requests.
  const channelFetchRef = useRef<string | null>(null);

  useEffect(() => {
    if (activeServerId) {
      if (channelFetchRef.current !== activeServerId) {
        channelFetchRef.current = activeServerId;
        fetchChannels(activeServerId);
      }
    } else {
      channelFetchRef.current = null;
      clearChannels();
    }
    return () => {
      // Allow refetch if effect re-runs with a different serverId
      // (but NOT on StrictMode unmount — ref persists across remounts)
    };
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

  // Gap zones between categories — dropping here makes a channel uncategorized
  const handleGapDragOver = useCallback((e: React.DragEvent, gapId: string) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    const newPos = { targetId: gapId, side: 'after' as const, targetType: 'gap' as const };
    lastInsertRef.current = newPos;
    setDragInsertPos(newPos);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    // Read from ref (always current) instead of state closure (can be stale)
    const insertPos = lastInsertRef.current;
    // Clear ref immediately to prevent duplicate processing from event bubbling
    // (drop fires on the item, then bubbles to the container)
    lastInsertRef.current = null;
    // Defer React state cleanup so the browser's dragend fires on the original DOM
    // (prevents soft-lock caused by DOM mutations mid-drag lifecycle)
    requestAnimationFrame(() => handleDragEnd());

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
      const nonLinked = channels.filter((c) => !c.linked_voice_channel_id);
      const sortedGroups = [...channelGroups].sort((a, b) => a.position - b.position);
      const sourceChannel = nonLinked.find((c) => c.id === sourceId);
      if (!sourceChannel) return;

      // Determine target group and slot for gap drops
      const targetChannel = nonLinked.find((c) => c.id === insertPos.targetId);
      const targetGroup = insertPos.targetType === 'category'
        ? channelGroups.find((g) => g.id === insertPos.targetId)
        : null;

      let targetGroupId: string | null;
      let gapSlot: number | null = null; // which inter-category slot for gap drops

      if (insertPos.targetType === 'gap') {
        targetGroupId = null;
        // Parse gap ID to determine slot index
        const gapId = insertPos.targetId;
        if (gapId === '__gap-bottom' || gapId === '__gap-uncategorized') {
          gapSlot = sortedGroups.length; // after last category
        } else if (gapId.startsWith('__gap-before-')) {
          const catId = gapId.replace('__gap-before-', '');
          const catIdx = sortedGroups.findIndex((g) => g.id === catId);
          gapSlot = catIdx >= 0 ? catIdx : 0;
        }
      } else if (targetGroup) {
        targetGroupId = targetGroup.id;
      } else if (targetChannel) {
        targetGroupId = targetChannel.group_id || null;
      } else {
        return;
      }

      const updates: { channel_id: string; group_id: string | null; position: number }[] = [];

      if (insertPos.targetType === 'gap' && gapSlot !== null) {
        // Gap drop: make uncategorized with slot-encoded position.
        // Collect existing uncategorized channels in this same slot (excluding source).
        const slotBase = (gapSlot + 1) * 1000;
        const slotEnd = slotBase + 1000;
        const sameSlot = nonLinked
          .filter((c) => !c.group_id && c.id !== sourceId && c.position >= slotBase && c.position < slotEnd)
          .sort((a, b) => a.position - b.position);
        // Append source at end of slot
        sameSlot.push(sourceChannel);
        sameSlot.forEach((c, i) => {
          updates.push({ channel_id: c.id, group_id: null, position: slotBase + i });
        });
      } else {
        // Normal drop (into a category or reorder within group)
        const groupChans = nonLinked
          .filter((c) => (targetGroupId ? c.group_id === targetGroupId : !c.group_id))
          .filter((c) => c.id !== sourceId)
          .sort((a, b) => a.position - b.position);

        let insertIdx: number;
        if (targetGroup) {
          insertIdx = groupChans.length;
        } else {
          const targetIdx = groupChans.findIndex((c) => c.id === insertPos.targetId);
          insertIdx = insertPos.side === 'after' ? targetIdx + 1 : targetIdx;
          if (insertIdx < 0) insertIdx = groupChans.length;
        }
        groupChans.splice(insertIdx, 0, sourceChannel);

        if (targetGroupId) {
          // Inside a category: simple 0-based positions
          groupChans.forEach((c, i) => {
            updates.push({ channel_id: c.id, group_id: targetGroupId, position: i });
          });
        } else {
          // Reordering within uncategorized — preserve slot encoding.
          // Determine which slot this drop targets based on the target channel's position.
          let slot = sortedGroups.length; // default: after last category
          if (targetChannel && targetChannel.position >= 1000) {
            slot = Math.floor(targetChannel.position / 1000) - 1;
            slot = Math.max(0, Math.min(slot, sortedGroups.length));
          }
          const slotBase = (slot + 1) * 1000;
          groupChans.forEach((c, i) => {
            updates.push({ channel_id: c.id, group_id: null, position: slotBase + i });
          });
        }
      }

      // If source moved between groups, also reorder the old group
      const oldGroupId = sourceChannel.group_id || null;
      if (oldGroupId !== targetGroupId) {
        const oldGroupChans = nonLinked
          .filter((c) => (oldGroupId ? c.group_id === oldGroupId : !c.group_id))
          .filter((c) => c.id !== sourceId)
          .sort((a, b) => a.position - b.position);
        if (oldGroupId) {
          // Simple 0-based for categorized
          oldGroupChans.forEach((c, i) => {
            updates.push({ channel_id: c.id, group_id: oldGroupId, position: i });
          });
        } else {
          // Uncategorized: re-pack each slot to close gaps
          const slotMap = new Map<number, Channel[]>();
          for (const c of oldGroupChans) {
            const s = c.position >= 1000 ? Math.floor(c.position / 1000) - 1 : sortedGroups.length;
            if (!slotMap.has(s)) slotMap.set(s, []);
            slotMap.get(s)!.push(c);
          }
          for (const [s, chans] of slotMap) {
            const base = (s + 1) * 1000;
            chans.sort((a, b) => a.position - b.position).forEach((c, i) => {
              updates.push({ channel_id: c.id, group_id: null, position: base + i });
            });
          }
        }
      }

      // Optimistic update + API call
      reorderChannels(updates);
      apiFetch(`/api/v1/servers/${activeServerId}/channels/reorder`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channels: updates }),
      }).catch(() => {
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
  }, [activeServerId, channels, channelGroups, reorderChannels, updateChannelGroup, fetchChannels, handleDragEnd]);

  // Build interleaved channel structure: categories sorted by position, with
  // uncategorized channels able to appear between/above/below categories.
  //
  // Uncategorized channels use a slot-encoded position: (slot+1)*1000 + orderInSlot
  //   slot 0 → before first category, slot 1 → after first category, etc.
  // Legacy channels (position < 1000) render at the bottom for backward compat.
  // Filter out linked text channels — they render inline below their parent voice channel.
  const groupedChannels = useMemo(() => {
    const nonLinked = channels.filter((c) => !c.linked_voice_channel_id);
    const sortedGroups = [...channelGroups].sort((a, b) => a.position - b.position);
    const numSlots = sortedGroups.length + 1; // slots 0..N (before first, between each, after last)

    // Separate uncategorized channels into slots
    const uncategorized = nonLinked.filter((c) => !c.group_id);
    const slotBuckets: Channel[][] = Array.from({ length: numSlots }, () => []);
    const legacyBucket: Channel[] = [];

    for (const ch of uncategorized) {
      if (ch.position >= 1000) {
        const slot = Math.floor(ch.position / 1000) - 1;
        const clampedSlot = Math.max(0, Math.min(slot, numSlots - 1));
        slotBuckets[clampedSlot].push(ch);
      } else {
        legacyBucket.push(ch);
      }
    }
    // Sort within each bucket by position
    for (const bucket of slotBuckets) bucket.sort((a, b) => a.position - b.position);
    legacyBucket.sort((a, b) => a.position - b.position);

    // Interleave: slot0, category0, slot1, category1, ..., slotN, legacy
    const result: { group: ChannelGroup | null; channels: Channel[]; slotIndex?: number }[] = [];

    for (let i = 0; i <= sortedGroups.length; i++) {
      if (slotBuckets[i].length > 0) {
        result.push({ group: null, channels: slotBuckets[i], slotIndex: i });
      }
      if (i < sortedGroups.length) {
        const g = sortedGroups[i];
        result.push({
          group: g,
          channels: nonLinked
            .filter((c) => c.group_id === g.id)
            .sort((a, b) => a.position - b.position),
        });
      }
    }

    // Legacy uncategorized at the bottom
    if (legacyBucket.length > 0) {
      result.push({ group: null, channels: legacyBucket });
    }

    return result;
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

  // Clear unread for linked text channel while voice text chat is open
  // (handles new messages arriving while the panel is visible)
  useEffect(() => {
    if (!showVoiceTextChat || !voiceChannelId) return;
    const linked = linkedTextByVoice.get(voiceChannelId);
    if (!linked) return;
    const count = unreadCounts.get(linked.id);
    if (count && count > 0) {
      clearUnread(linked.id);
      apiFetch(`/api/v1/channels/${linked.id}/read`, { method: 'POST' }).catch(() => {});
    }
  }, [showVoiceTextChat, voiceChannelId, linkedTextByVoice, unreadCounts, clearUnread]);

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
    const isLinkedTextActive = showLinkedText && showVoiceTextChat;

    // Build class list for grouped hierarchy
    const itemClasses = [
      'channel-item',
      isActive ? 'active' : '',
      unread > 0 ? 'has-unread' : '',
      isGrouped ? 'channel-item--grouped' : '',
      isLastInGroup ? 'channel-item--grouped-last' : '',
    ].filter(Boolean).join(' ');

    const isDragging = draggingId === channel.id;
    const showGhostBefore = dragInsertPos?.targetId === channel.id && dragInsertPos?.side === 'before';
    const showGhostAfter = dragInsertPos?.targetId === channel.id && dragInsertPos?.side === 'after';

    return (
      <React.Fragment key={channel.id}>
        <div className={`channel-item-wrapper${isGrouped ? ' channel-item-wrapper--grouped' : ''}`}>
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
          {showGhostAfter && <div className="channel-drag-ghost" />}
        </div>
        {/* Voice sub-items — rendered outside the grouped wrapper so category
            trunk lines don't extend through them. Wrapped in a container for
            subtle visual grouping that grows with the member list. */}
        {((showLinkedText && linkedText) || voiceMembers.length > 0) && (
          <div
            className={`voice-channel-sub-container ${isGrouped ? 'voice-channel-sub-container--grouped' : ''} ${isActive ? 'voice-channel-sub-container--active' : ''}`}
            onClick={() => handleChannelClick(channel)}
          >
            {showLinkedText && linkedText && (
              <div
                className={`channel-item--voice-text ${isGrouped ? 'channel-item--voice-text-grouped' : ''} ${isLinkedTextActive ? 'active' : ''} ${linkedTextUnread > 0 ? 'has-unread' : ''}`}
                onClick={(e) => {
                  e.stopPropagation();
                  // Keep voice channel active and toggle the integrated text chat panel
                  setActiveChannel(channel.id);
                  const opening = !showVoiceTextChat;
                  setShowVoiceTextChat(opening);
                  // Clear unread badge for the linked text channel when opening
                  if (opening && linkedText) {
                    clearUnread(linkedText.id);
                    apiFetch(`/api/v1/channels/${linkedText.id}/read`, { method: 'POST' }).catch(() => {});
                  }
                }}
                title={`${channel.name} Text Chat`}
              >
                <span className="channel-type-icon"><MessageSquare size={12} /></span>
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
          </div>
        )}
      </React.Fragment>
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
    <div
      className="channel-list"
      onContextMenu={handleEmptyContextMenu}
      onDragOver={canReorder ? (e) => e.preventDefault() : undefined}
      onDrop={canReorder ? handleDrop : undefined}
    >
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

      {/* Empty State — only when no channels AND no categories */}
      {!isLoading && !error && channels.length === 0 && channelGroups.length === 0 && (
        <div className="channel-list-empty">
          <p>No channels yet</p>
          <p className="channel-list-empty-hint">Use "+ Add" above to create one</p>
        </div>
      )}

      {/* Dynamic Channel Groups */}
      {(channels.length > 0 || channelGroups.length > 0) && (
        <>
          {groupedChannels.map(({ group, channels: groupChannels, slotIndex }, _groupIdx) => {
            const groupId = group?.id ?? `__uncategorized-${slotIndex ?? 'legacy'}`;
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
            const showCategoryGhostBefore = dragInsertPos?.targetId === group.id && dragInsertPos?.side === 'before';
            const showCategoryGhostAfter = dragInsertPos?.targetId === group.id && dragInsertPos?.side === 'after' && isCollapsed;
            const isCategoryDragOver = draggingType === 'channel' && dragInsertPos?.targetId === group.id && dragInsertPos?.targetType === 'category';

            // Gap zone IDs for before this category
            const gapId = `__gap-before-${group.id}`;
            const isGapActive = dragInsertPos?.targetId === gapId;

            return (
              <React.Fragment key={groupId}>
                {/* Gap zone before category — drop here to ungroup a channel */}
                <div
                  className={`channel-drag-gap ${draggingType === 'channel' ? 'channel-drag-gap--visible' : ''} ${isGapActive ? 'channel-drag-gap--active' : ''}`}
                  onDragOver={(e) => handleGapDragOver(e, gapId)}
                  onDrop={handleDrop}
                />
                <div className="channel-group">
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
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onCategoryContextMenu(group, { x: e.clientX, y: e.clientY });
                    }}
                  >
                    <span className="channel-group-header__chevron">
                      {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                    </span>
                    <span>{(group.name ?? '').toUpperCase()}</span>
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
              </React.Fragment>
            );
          })}
          {/* Gap zone after all groups — drop here to ungroup at the bottom */}
          {channelGroups.length > 0 && (
            <div
              className={`channel-drag-gap ${draggingType === 'channel' ? 'channel-drag-gap--visible' : ''} ${dragInsertPos?.targetId === '__gap-bottom' ? 'channel-drag-gap--active' : ''}`}
              onDragOver={(e) => handleGapDragOver(e, '__gap-bottom')}
              onDrop={handleDrop}
            />
          )}
        </>
      )}
    </div>
  );
};

export default ChannelList;
