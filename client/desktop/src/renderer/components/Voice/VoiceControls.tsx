import React from 'react';
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
} from 'lucide-react';
import { useVoiceStore } from '../../stores/voiceStore';
import { getVoiceService } from '../../services/voiceLazy';
import './VoiceControls.css';

interface VoiceControlsProps {
  /** Show full controls bar (in VoiceView) vs compact mini-bar (in sidebar) */
  variant?: 'full' | 'compact';
}

const VoiceControls: React.FC<VoiceControlsProps> = ({ variant = 'full' }) => {
  const {
    activeChannelName,
    connectionState,
    isEncrypted,
    isMuted,
    isDeafened,
    isVideoOn,
    isScreenSharing,
    participants,
  } = useVoiceStore();

  const participantCount = Object.keys(participants).length;

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
    const { voiceService } = await getVoiceService();
    await voiceService.toggleScreenShare();
  };

  const handleLeave = async () => {
    const { voiceService } = await getVoiceService();
    await voiceService.leaveChannel();
  };

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
    <div className="voice-controls voice-controls--full">
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
  );
};

export default VoiceControls;
