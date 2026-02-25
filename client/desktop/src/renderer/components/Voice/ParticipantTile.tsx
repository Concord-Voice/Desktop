import React, { useRef, useEffect } from 'react';
import { MicOff, Monitor } from 'lucide-react';
import type { VoiceParticipant } from '../../stores/voiceStore';
import './ParticipantTile.css';

interface ParticipantTileProps {
  participant: VoiceParticipant;
  isLocal?: boolean;
  size?: 'small' | 'normal' | 'large';
}

const ParticipantTile: React.FC<ParticipantTileProps> = ({
  participant,
  isLocal = false,
  size = 'normal',
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);

  // Attach video stream to video element
  useEffect(() => {
    const el = videoRef.current;
    if (el && participant.videoStream) {
      el.srcObject = participant.videoStream;
      // Explicit play() — autoPlay attribute alone can be blocked by Chrome's
      // autoplay policy in some edge cases (dynamic element creation, etc.)
      el.play().catch(() => {});
    }
    return () => {
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
    };
  }, [participant.videoStream]);

  const displayName = participant.displayName || participant.username;
  const hasVideo = participant.isVideoOn && participant.videoStream;

  return (
    <div
      className={`participant-tile participant-tile--${size} ${
        participant.isSpeaking ? 'participant-tile--speaking' : ''
      }`}
    >
      {hasVideo ? (
        <video
          ref={videoRef}
          className="participant-tile__video"
          autoPlay
          playsInline
          muted
        />
      ) : (
        <div className="participant-tile__avatar">
          {participant.avatarUrl ? (
            <img
              src={participant.avatarUrl}
              alt={displayName}
              className="participant-tile__avatar-img"
            />
          ) : (
            <div className="participant-tile__avatar-fallback">
              {displayName.charAt(0).toUpperCase()}
            </div>
          )}
        </div>
      )}

      {/* Status overlays */}
      <div className="participant-tile__overlays">
        {participant.isMuted && (
          <div className="participant-tile__status participant-tile__status--muted">
            <MicOff size={14} />
          </div>
        )}
        {participant.isScreenSharing && (
          <div className="participant-tile__status participant-tile__status--screen">
            <Monitor size={14} />
          </div>
        )}
        {!participant.isVideoOn && participant.videoStream === undefined && (
          <div className="participant-tile__status participant-tile__status--no-video" />
        )}
      </div>

      {/* Name label */}
      <div className="participant-tile__name">
        <span className="participant-tile__name-text">
          {displayName}
          {isLocal && ' (You)'}
        </span>
      </div>
    </div>
  );
};

export default ParticipantTile;
