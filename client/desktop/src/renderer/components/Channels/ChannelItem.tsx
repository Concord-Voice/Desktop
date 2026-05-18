import React from 'react';
import {
  Hash,
  Volume2,
  Pin,
  Lock,
  Mic,
  MicOff,
  HeadphoneOff,
  MessageSquare,
  PenLine,
} from 'lucide-react';
import type { Channel } from '../../types/chat';

export interface VoiceMemberInfo {
  userId: string;
  displayName?: string;
  username: string;
  isMuted: boolean;
  isSpeaking?: boolean;
  serverMuted: boolean;
  serverDeafened: boolean;
  isDeafened: boolean;
}

interface ChannelItemProps {
  channel: Channel;
  isActive: boolean;
  unread: number;
  isGrouped: boolean;
  isLastInGroup: boolean;
  voiceMembers: VoiceMemberInfo[];
  linkedText: Channel | null;
  showLinkedText: boolean;
  isLinkedTextActive: boolean;
  linkedTextUnread: number;
  hasDraft?: boolean;
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
  itemRef: (id: string, el: HTMLElement | null) => void;
}

function VoiceStatusIcon({ p }: Readonly<{ p: VoiceMemberInfo }>) {
  if (p.serverDeafened) {
    return (
      <span className="voice-channel-participant__icon voice-channel-participant__icon--server-enforced">
        <HeadphoneOff size={12} />
        <Lock size={6} className="voice-channel-participant__lock" />
      </span>
    );
  }
  if (p.serverMuted) {
    return (
      <span className="voice-channel-participant__icon voice-channel-participant__icon--server-enforced">
        <MicOff size={12} />
        <Lock size={6} className="voice-channel-participant__lock" />
      </span>
    );
  }
  if (p.isDeafened) {
    return <HeadphoneOff size={12} className="voice-channel-participant__icon--muted" />;
  }
  if (p.isMuted) {
    return <MicOff size={12} className="voice-channel-participant__icon--muted" />;
  }
  return <Mic size={12} />;
}

function VoiceSubItems({
  channel,
  isGrouped,
  isActive,
  showLinkedText,
  linkedText,
  isLinkedTextActive,
  linkedTextUnread,
  voiceMembers,
  onLinkedTextClick,
}: Readonly<{
  channel: Channel;
  isGrouped: boolean;
  isActive: boolean;
  showLinkedText: boolean;
  linkedText: Channel | null;
  isLinkedTextActive: boolean;
  linkedTextUnread: number;
  voiceMembers: VoiceMemberInfo[];
  onLinkedTextClick: (voiceChannel: Channel, linkedText: Channel) => void;
}>) {
  return (
    <div
      className={`voice-channel-sub-container ${isGrouped ? 'voice-channel-sub-container--grouped' : ''} ${isActive ? 'voice-channel-sub-container--active' : ''}`}
    >
      {showLinkedText && linkedText && (
        <button
          type="button"
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
        </button>
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
              <VoiceStatusIcon p={p} />
              <span className="voice-channel-participant-name">{p.displayName || p.username}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
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
  hasDraft,
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
        <button
          type="button"
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
          <span className="channel-encrypted-icon" title="End-to-End Encrypted">
            <Lock size={12} />
          </span>
          {hasDraft && !isActive && (
            <span className="channel-draft-indicator" title="Draft message">
              <PenLine size={12} />
            </span>
          )}
          {unread > 0 && !isActive && (
            <span className="channel-unread-badge">{unread > 99 ? '99+' : unread}</span>
          )}
        </button>
        {showGhostAfter && <div className="channel-drag-ghost" />}
      </div>
      {((showLinkedText && linkedText) || voiceMembers.length > 0) && (
        <VoiceSubItems
          channel={channel}
          isGrouped={isGrouped}
          isActive={isActive}
          showLinkedText={showLinkedText}
          linkedText={linkedText}
          isLinkedTextActive={isLinkedTextActive}
          linkedTextUnread={linkedTextUnread}
          voiceMembers={voiceMembers}
          onLinkedTextClick={onLinkedTextClick}
        />
      )}
    </React.Fragment>
  );
};

export default React.memo(ChannelItem);
