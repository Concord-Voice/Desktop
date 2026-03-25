import React from 'react';
import { Hash, Volume2, Pin, Lock, Mic, MicOff, MessageSquare } from 'lucide-react';
import type { Channel } from '../../types/chat';

export interface VoiceMemberInfo {
  userId: string;
  displayName?: string;
  username: string;
  isMuted: boolean;
  isSpeaking?: boolean;
}

interface ChannelItemProps {
  channel: Channel;
  isActive: boolean;
  unread: number;
  isGrouped: boolean;
  isLastInGroup: boolean;
  isVoiceConnected: boolean;
  voiceMembers: VoiceMemberInfo[];
  linkedText: Channel | null;
  showLinkedText: boolean;
  isLinkedTextActive: boolean;
  linkedTextUnread: number;
  canReorder: boolean;
  isDragging: boolean;
  showGhostBefore: boolean;
  showGhostAfter: boolean;
  onChannelClick: (channel: Channel) => void;
  onContextMenu: (e: React.MouseEvent, channel: Channel) => void;
  onDragStart: (e: React.DragEvent, id: string, type: 'channel' | 'category') => void;
  onDragOver: (e: React.DragEvent, id: string, type: 'channel' | 'category') => void;
  onDrop: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onLinkedTextClick: (voiceChannel: Channel, linkedText: Channel) => void;
  itemRef: (id: string, el: HTMLDivElement | null) => void;
}

function getChannelTypeIcon(type: Channel['type']) {
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
}

const ChannelItem: React.FC<ChannelItemProps> = ({
  channel,
  isActive,
  unread,
  isGrouped,
  isLastInGroup,
  voiceMembers,
  linkedText,
  showLinkedText,
  isLinkedTextActive,
  linkedTextUnread,
  canReorder,
  isDragging,
  showGhostBefore,
  showGhostAfter,
  onChannelClick,
  onContextMenu,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onLinkedTextClick,
  itemRef,
}) => {
  const itemClasses = [
    'channel-item',
    isActive ? 'active' : '',
    unread > 0 ? 'has-unread' : '',
    isGrouped ? 'channel-item--grouped' : '',
    isLastInGroup ? 'channel-item--grouped-last' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <React.Fragment>
      <div className={`channel-item-wrapper${isGrouped ? ' channel-item-wrapper--grouped' : ''}`}>
        {showGhostBefore && <div className="channel-drag-ghost" />}
        <div
          ref={(el) => itemRef(channel.id, el)}
          className={`${itemClasses} ${isDragging ? 'dragging' : ''}`}
          draggable={canReorder}
          onDragStart={(e) => onDragStart(e, channel.id, 'channel')}
          onDragOver={(e) => onDragOver(e, channel.id, 'channel')}
          onDrop={onDrop}
          onDragEnd={onDragEnd}
          onClick={() => onChannelClick(channel)}
          onContextMenu={(e) => onContextMenu(e, channel)}
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
        >
          {showLinkedText && linkedText && (
            <div
              className={`channel-item--voice-text ${isGrouped ? 'channel-item--voice-text-grouped' : ''} ${isLinkedTextActive ? 'active' : ''} ${linkedTextUnread > 0 ? 'has-unread' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                onLinkedTextClick(channel, linkedText);
              }}
              title={`${channel.name} Text Chat`}
            >
              <span className="channel-type-icon">
                <MessageSquare size={12} />
              </span>
              <span className="channel-name">{channel.name} Text Chat</span>
              {linkedTextUnread > 0 && !isLinkedTextActive && (
                <span className="channel-unread-badge">
                  {linkedTextUnread > 99 ? '99+' : linkedTextUnread}
                </span>
              )}
            </div>
          )}
          {voiceMembers.length > 0 && (
            <div
              className={`voice-channel-participants ${isGrouped ? 'voice-channel-participants--grouped' : ''}`}
            >
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

export default React.memo(ChannelItem);
