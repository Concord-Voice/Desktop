import React, { useEffect, useRef, useCallback } from 'react';
import { Lock, Users, ChevronUp, ChevronDown } from 'lucide-react';
import { useVoiceStore } from '../../stores/voiceStore';
import { useChannelStore } from '../../stores/channelStore';
import { getVoiceService } from '../../services/voiceLazy';
import { AudioOutputs, UserFrameGrid } from './ParticipantGrid';
import UserFrameBar from './UserFrameBar';
import VoiceStage from './VoiceStage';
import StreamBar from './StreamBar';
import { TuneInOverlay } from './TuneInButton';
import VoiceControls from './VoiceControls';
import VoiceTextChat from './VoiceTextChat';
import './VoiceView.css';

interface VoiceViewProps {
  channelId: string;
  channelName: string;
}

const MIN_CHAT_HEIGHT = 150;
const MAX_CHAT_RATIO = 0.7;
const MIN_SECTION_HEIGHT = 80;

const VoiceView: React.FC<VoiceViewProps> = ({ channelId, channelName }) => {
  const {
    activeChannelId,
    connectionState,
    isEncrypted,
    participants,
    channelVoiceMembers,
    effectiveQualityTier,
    decoderHealth,
    showVoiceTextChat,
    voiceTextChatHeight,
    setVoiceTextChatHeight,
    tunedInScreenShares,
    availableScreenShares,
    showUserFrameBar,
    showStreamBar,
    userFrameBarHeight,
    streamBarHeight,
    setUserFrameBarHeight,
    setStreamBarHeight,
    toggleUserFrameBar,
    toggleStreamBar,
    stageLayout,
    isScreenSharing,
    keepActiveWhileUnfocused,
  } = useVoiceStore();

  const getLinkedTextChannel = useChannelStore((s) => s.getLinkedTextChannel);
  const hasLinkedText = !!getLinkedTextChannel(channelId);

  const hasJoinedRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const resizingRef = useRef(false);
  const participantCount = Object.keys(participants).length;

  const hasScreenShares = Object.keys(tunedInScreenShares).length > 0;

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

  useEffect(() => {
    hasJoinedRef.current = isConnected;
  }, [channelId, isConnected]);

  // Pause local screen share when window loses focus (unless keepActiveWhileUnfocused)
  const screenPausedByFocusRef = useRef(false);

  useEffect(() => {
    if (!isConnected || !isScreenSharing) {
      screenPausedByFocusRef.current = false;
      return;
    }

    const handleVisibility = async () => {
      if (keepActiveWhileUnfocused) return;
      const { voiceService } = await getVoiceService();
      if (document.hidden) {
        voiceService.pauseLocalProducer('screen');
        screenPausedByFocusRef.current = true;
      } else if (screenPausedByFocusRef.current) {
        voiceService.resumeLocalProducer('screen');
        screenPausedByFocusRef.current = false;
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [isConnected, isScreenSharing, keepActiveWhileUnfocused]);

  // Text chat resize
  const handleChatResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      resizingRef.current = true;
      const startY = e.clientY;
      const startHeight = voiceTextChatHeight;

      const onMouseMove = (moveEvent: MouseEvent) => {
        if (!resizingRef.current || !containerRef.current) return;
        const containerHeight = containerRef.current.getBoundingClientRect().height;
        const maxHeight = containerHeight * MAX_CHAT_RATIO;
        const delta = startY - moveEvent.clientY;
        const newHeight = Math.min(maxHeight, Math.max(MIN_CHAT_HEIGHT, startHeight + delta));
        setVoiceTextChatHeight(newHeight);
      };

      const onMouseUp = () => {
        resizingRef.current = false;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    },
    [voiceTextChatHeight, setVoiceTextChatHeight]
  );

  // Section resize factory (for UserFrameBar / StreamBar)
  const makeSectionResizeStart = useCallback(
    (
      section: 'top' | 'bottom',
      currentHeight: number,
      setter: (h: number) => void
    ) =>
      (e: React.MouseEvent) => {
        e.preventDefault();
        const startY = e.clientY;
        const startHeight = currentHeight;

        const onMouseMove = (moveEvent: MouseEvent) => {
          const delta = section === 'top'
            ? moveEvent.clientY - startY
            : startY - moveEvent.clientY;
          const newHeight = Math.max(MIN_SECTION_HEIGHT, startHeight + delta);
          setter(newHeight);
        };

        const onMouseUp = () => {
          document.removeEventListener('mousemove', onMouseMove);
          document.removeEventListener('mouseup', onMouseUp);
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
      },
    []
  );

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

  const showChat = showVoiceTextChat && hasLinkedText;
  const tunedInCount = Object.keys(tunedInScreenShares).length;
  const nonDominantCount = tunedInCount - 1;
  const showStreamSection = stageLayout === 'focus' && nonDominantCount > 0;

  return (
    <div className="voice-view" ref={containerRef}>
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
          <span className="voice-view__badge voice-view__badge--quality">
            {effectiveQualityTier}
          </span>
          {decoderHealth !== 'green' && (
            <span className={`voice-view__badge voice-view__badge--decoder-${decoderHealth}`}>
              {decoderHealth === 'yellow' ? 'Decode Warning' : 'Decode Overload'}
            </span>
          )}
        </div>
      </div>

      {/* Voice area — one resizable entity vs text chat */}
      <div className="voice-view__voice-area">
        {/* Audio outputs (always rendered, hidden) */}
        <AudioOutputs />

        {hasScreenShares ? (
          /* Mode B: Three-section layout */
          <>
            {/* User Frame Bar (top) */}
            {showUserFrameBar && (
              <UserFrameBar height={userFrameBarHeight} />
            )}

            {/* Resize handle: UserFrameBar ↔ VoiceStage */}
            <div className="voice-view__section-handle">
              <div
                className="voice-view__section-handle-grip"
                onMouseDown={makeSectionResizeStart('top', userFrameBarHeight, setUserFrameBarHeight)}
              />
              <button
                className="voice-view__section-toggle"
                onClick={toggleUserFrameBar}
                title={showUserFrameBar ? 'Hide user frames' : 'Show user frames'}
              >
                {showUserFrameBar ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              </button>
            </div>

            {/* Center Stage (dominant screen share) */}
            <VoiceStage />

            {/* Resize handle: VoiceStage ↔ StreamBar (focus mode only) */}
            {showStreamSection && (
              <div className="voice-view__section-handle">
                <div
                  className="voice-view__section-handle-grip"
                  onMouseDown={makeSectionResizeStart('bottom', streamBarHeight, setStreamBarHeight)}
                />
                <button
                  className="voice-view__section-toggle"
                  onClick={toggleStreamBar}
                  title={showStreamBar ? 'Hide stream bar' : 'Show stream bar'}
                >
                  {showStreamBar ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
                </button>
              </div>
            )}

            {/* Stream Bar (bottom — non-dominant shares, focus mode only) */}
            {showStreamSection && showStreamBar && (
              <StreamBar height={streamBarHeight} />
            )}
          </>
        ) : (
          /* Mode A: Centered user frames */
          <UserFrameGrid />
        )}

        {/* Available screen shares — Tune In buttons */}
        {availableScreenShares.length > 0 && <TuneInOverlay />}
      </div>

      {/* Text chat panel (when toggled on) */}
      {showChat && (
        <>
          <div
            className="voice-text-chat-resize"
            onMouseDown={handleChatResizeStart}
          >
            <div className="voice-text-chat-resize__grip" />
          </div>
          <div
            className="voice-view__text-chat"
            style={{ height: voiceTextChatHeight }}
          >
            <VoiceTextChat />
          </div>
        </>
      )}

      {/* Controls bar */}
      <VoiceControls variant="full" />
    </div>
  );
};

export default VoiceView;
