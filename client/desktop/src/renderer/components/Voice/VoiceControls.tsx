import React, { useState, useEffect } from 'react';
import {
  Mic,
  MicOff,
  Headphones,
  HeadphoneOff,
  Video,
  VideoOff,
  Monitor,
  MonitorOff,
  PhoneOff,
  Lock,
  MessageSquare,
  MessageSquareOff,
  PictureInPicture2,
} from 'lucide-react';
import { useVoiceStore } from '../../stores/voiceStore';
import { useChannelStore } from '../../stores/channelStore';
import { getVoiceService } from '../../services/voiceLazy';
import ScreenSharePicker from './ScreenSharePicker';
import './VoiceControls.css';

interface VoiceControlsProps {
  /** Show full controls bar (in VoiceView) vs compact mini-bar (in sidebar) */
  variant?: 'full' | 'compact';
}

const VoiceControls: React.FC<VoiceControlsProps> = ({ variant = 'full' }) => {
  const {
    activeChannelId,
    activeChannelName,
    connectionState,
    isEncrypted,
    isMuted,
    isDeafened,
    isVideoOn,
    isScreenSharing,
    showVoiceTextChat,
    toggleVoiceTextChat,
    participants,
    videoSlotError,
    setVideoSlotError,
    tunedInScreenShares,
    pipWindows,
    addPipWindow,
  } = useVoiceStore();

  const getLinkedTextChannel = useChannelStore((s) => s.getLinkedTextChannel);
  const hasLinkedText = !!(activeChannelId && getLinkedTextChannel(activeChannelId));

  const [showScreenPicker, setShowScreenPicker] = useState(false);
  const [showPipMenu, setShowPipMenu] = useState(false);
  const participantCount = Object.keys(participants).length;
  const hasPipSupport = !!window.electron?.openPipWindow;

  const handleToggleMute = async () => {
    const { voiceService } = await getVoiceService();
    voiceService.toggleMute();
  };

  const handleToggleDeafen = async () => {
    const { voiceService } = await getVoiceService();
    voiceService.toggleDeafen();
  };

  const handleToggleVideo = async () => {
    const { voiceService } = await getVoiceService();
    await voiceService.toggleVideo();
  };

  const handleToggleScreen = async () => {
    try {
      if (isScreenSharing) {
        // Stop sharing — no picker needed
        const { voiceService } = await getVoiceService();
        await voiceService.toggleScreenShare();
      } else {
        // Start sharing — show picker if Electron API is available
        if (window.electron?.getDesktopSources) {
          setShowScreenPicker(true);
        } else {
          // Fallback: browser getDisplayMedia shows its own native picker
          const { voiceService } = await getVoiceService();
          await voiceService.toggleScreenShare();
        }
      }
    } catch (err) {
      console.error('Failed to toggle screen share:', err);
    }
  };

  const handleScreenSourceSelected = async (sourceId: string) => {
    setShowScreenPicker(false);
    try {
      const { voiceService } = await getVoiceService();
      await voiceService.toggleScreenShare(sourceId);
    } catch (err) {
      console.error('Failed to start screen share:', err);
    }
  };

  const handleLeave = async () => {
    const { voiceService } = await getVoiceService();
    await voiceService.leaveChannel();
  };

  // Auto-dismiss video slot error after 5 seconds
  useEffect(() => {
    if (!videoSlotError) return;
    const timer = setTimeout(() => setVideoSlotError(null), 5000);
    return () => clearTimeout(timer);
  }, [videoSlotError, setVideoSlotError]);

  const handleOpenPip = (id: string, title: string, width?: number, height?: number) => {
    window.electron?.openPipWindow({ id, title, width, height });
    addPipWindow(id);
    setShowPipMenu(false);
  };

  const tunedInIds = Object.keys(tunedInScreenShares);

  if (connectionState === 'disconnected') return null;

  if (variant === 'compact') {
    return (
      <div className="voice-controls voice-controls--compact">
        <div className="voice-controls__info">
          <span className="voice-controls__status-dot" />
          <span className="voice-controls__channel-name">
            {activeChannelName || 'Voice Connected'}
          </span>
          {isEncrypted && <Lock size={12} className="voice-controls__lock" />}
          <span className="voice-controls__count">{participantCount}</span>
        </div>
        <div className="voice-controls__buttons">
          <button
            className={`voice-controls__btn ${isMuted ? 'voice-controls__btn--active' : ''}`}
            onClick={handleToggleMute}
            title={isMuted ? 'Unmute' : 'Mute'}
          >
            {isMuted ? <MicOff size={16} /> : <Mic size={16} />}
          </button>
          <button
            className={`voice-controls__btn ${isDeafened ? 'voice-controls__btn--active' : ''}`}
            onClick={handleToggleDeafen}
            title={isDeafened ? 'Undeafen' : 'Deafen'}
          >
            {isDeafened ? <HeadphoneOff size={16} /> : <Headphones size={16} />}
          </button>
          <button
            className="voice-controls__btn voice-controls__btn--danger"
            onClick={handleLeave}
            title="Leave Voice"
          >
            <PhoneOff size={16} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="voice-controls voice-controls--full">
        {videoSlotError && (
          <div className="voice-controls__slot-error">
            {videoSlotError}
          </div>
        )}
        <div className="voice-controls__buttons">
          <button
            className={`voice-controls__btn ${isMuted ? 'voice-controls__btn--active' : ''}`}
            onClick={handleToggleMute}
            title={isMuted ? 'Unmute' : 'Mute'}
          >
            {isMuted ? <MicOff size={18} /> : <Mic size={18} />}
            <span className="voice-controls__btn-label">{isMuted ? 'Unmute' : 'Mute'}</span>
          </button>

          <button
            className={`voice-controls__btn ${isDeafened ? 'voice-controls__btn--active' : ''}`}
            onClick={handleToggleDeafen}
            title={isDeafened ? 'Undeafen' : 'Deafen'}
          >
            {isDeafened ? <HeadphoneOff size={18} /> : <Headphones size={18} />}
            <span className="voice-controls__btn-label">{isDeafened ? 'Undeafen' : 'Deafen'}</span>
          </button>

          <button
            className={`voice-controls__btn ${isVideoOn ? 'voice-controls__btn--active' : ''}`}
            onClick={handleToggleVideo}
            title={isVideoOn ? 'Stop Video' : 'Start Video'}
          >
            {isVideoOn ? <VideoOff size={18} /> : <Video size={18} />}
            <span className="voice-controls__btn-label">{isVideoOn ? 'Stop Video' : 'Video'}</span>
          </button>

          <button
            className={`voice-controls__btn ${isScreenSharing ? 'voice-controls__btn--active' : ''}`}
            onClick={handleToggleScreen}
            title={isScreenSharing ? 'Stop Sharing' : 'Share Screen'}
          >
            {isScreenSharing ? <MonitorOff size={18} /> : <Monitor size={18} />}
            <span className="voice-controls__btn-label">{isScreenSharing ? 'Stop' : 'Screen'}</span>
          </button>

          {hasLinkedText && (
            <button
              className={`voice-controls__btn ${showVoiceTextChat ? 'voice-controls__btn--chat-active' : ''}`}
              onClick={toggleVoiceTextChat}
              title={showVoiceTextChat ? 'Hide Text Chat' : 'Show Text Chat'}
            >
              {showVoiceTextChat ? <MessageSquareOff size={18} /> : <MessageSquare size={18} />}
              <span className="voice-controls__btn-label">Chat</span>
            </button>
          )}

          {hasPipSupport && (
            <div className="voice-controls__pip-wrap">
              <button
                className="voice-controls__btn"
                onClick={() => setShowPipMenu((v) => !v)}
                title="Picture-in-Picture"
              >
                <PictureInPicture2 size={18} />
                <span className="voice-controls__btn-label">PiP</span>
              </button>

              {showPipMenu && (
                <div className="voice-controls__pip-menu">
                  <button
                    className="voice-controls__pip-menu-item"
                    onClick={() => handleOpenPip('frames-main', 'User Frames', 320, 240)}
                    disabled={pipWindows.includes('frames-main')}
                  >
                    Pop Out User Frames
                  </button>
                  {tunedInIds.map((producerId) => {
                    const sharer = Object.values(participants).find(
                      (p) => p.isScreenSharing
                    );
                    const name = sharer?.displayName || sharer?.username || 'User';
                    const pipId = `screen-${producerId}`;
                    return (
                      <button
                        key={producerId}
                        className="voice-controls__pip-menu-item"
                        onClick={() => handleOpenPip(pipId, `${name}'s Screen`, 400, 300)}
                        disabled={pipWindows.includes(pipId)}
                      >
                        Pop Out {name}&apos;s Screen
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          <button
            className="voice-controls__btn voice-controls__btn--danger"
            onClick={handleLeave}
            title="Leave Voice"
          >
            <PhoneOff size={18} />
            <span className="voice-controls__btn-label">Leave</span>
          </button>
        </div>
      </div>

      {showScreenPicker && (
        <ScreenSharePicker
          onSelect={handleScreenSourceSelected}
          onCancel={() => setShowScreenPicker(false)}
        />
      )}
    </>
  );
};

export default VoiceControls;
