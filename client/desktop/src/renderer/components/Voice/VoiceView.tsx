import React, { useEffect, useRef } from 'react';
import { Lock, Users } from 'lucide-react';
import { useVoiceStore } from '../../stores/voiceStore';
import { getVoiceService } from '../../services/voiceLazy';
import ParticipantGrid from './ParticipantGrid';
import VoiceControls from './VoiceControls';
import './VoiceView.css';

interface VoiceViewProps {
  channelId: string;
  channelName: string;
}

const VoiceView: React.FC<VoiceViewProps> = ({ channelId, channelName }) => {
  const {
    activeChannelId,
    connectionState,
    isEncrypted,
    participants,
    channelVoiceMembers,
  } = useVoiceStore();

  const hasJoinedRef = useRef(false);
  const participantCount = Object.keys(participants).length;

  // Auto-connect when viewing a voice channel we're not connected to
  const isConnected = activeChannelId === channelId && connectionState === 'connected';
  const isConnecting = connectionState === 'connecting';

  const handleJoin = async () => {
    if (hasJoinedRef.current) return;
    hasJoinedRef.current = true;
    try {
      const { voiceService } = await getVoiceService();
      await voiceService.joinChannel(channelId);
    } catch {
      hasJoinedRef.current = false;
    }
  };

  // Reset join ref when channel changes
  useEffect(() => {
    hasJoinedRef.current = isConnected;
  }, [channelId, isConnected]);

  // Not connected — show join prompt
  if (!isConnected) {
    return (
      <div className="voice-view">
        <div className="voice-view__join">
          <div className="voice-view__join-icon">
            <Users size={48} />
          </div>
          <h2 className="voice-view__join-title">{channelName}</h2>
          <p className="voice-view__join-subtitle">
            {isConnecting
              ? 'Connecting...'
              : (channelVoiceMembers[channelId]?.length || 0) > 0
                ? `${channelVoiceMembers[channelId].length} user${channelVoiceMembers[channelId].length === 1 ? '' : 's'} in this channel`
                : 'No one is in this voice channel yet.'}
          </p>
          <button
            className="voice-view__join-btn"
            onClick={handleJoin}
            disabled={isConnecting}
          >
            {isConnecting ? 'Connecting...' : 'Join Voice'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="voice-view">
      {/* Header */}
      <div className="voice-view__header">
        <h2 className="voice-view__channel-name">{channelName}</h2>
        <div className="voice-view__header-meta">
          {isEncrypted && (
            <span className="voice-view__badge voice-view__badge--encrypted">
              <Lock size={12} />
              E2EE
            </span>
          )}
          <span className="voice-view__badge">
            <Users size={12} />
            {participantCount}
          </span>
        </div>
      </div>

      {/* Participant grid */}
      <ParticipantGrid />

      {/* Controls bar */}
      <VoiceControls variant="full" />
    </div>
  );
};

export default VoiceView;
