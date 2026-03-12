import React, { useRef, useEffect, useMemo } from 'react';
import { MicOff, Monitor } from 'lucide-react';
import type { VoiceParticipant } from '../../stores/voiceStore';
import { useMemberStore } from '../../stores/memberStore';
import { resolveUserAccentColors } from '../../utils/schemeColors';
import { useUserThemeScope } from '../../hooks/useUserThemeScope';
import './ParticipantTile.css';

interface ParticipantTileProps {
  participant: VoiceParticipant;
  isLocal?: boolean;
  compact?: boolean;
  magnificationScale?: number;
}

/**
 * Generate a consistent banner gradient from a userId.
 * Seeds two HSL hues 60deg apart from the char-code sum.
 */
function bannerGradient(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = ((hash << 5) - hash + userId.charCodeAt(i)) | 0;
  }
  const hue1 = (hash >>> 0) % 360;
  const hue2 = (hue1 + 60) % 360;
  return `linear-gradient(135deg, hsl(${hue1}, 60%, 35%), hsl(${hue2}, 60%, 25%))`;
}

const ParticipantTile: React.FC<ParticipantTileProps> = ({
  participant,
  isLocal = false,
  compact = false,
  magnificationScale = 1,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);

  // Attach video stream to video element
  useEffect(() => {
    const el = videoRef.current;
    if (el && participant.videoStream) {
      el.srcObject = participant.videoStream;
      el.play().catch(() => {});
    }
    return () => {
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
    };
  }, [participant.videoStream]);

  const displayName = participant.displayName || participant.username;
  // Auto-pause only applies to screen shares (VoiceStage/StreamBar), not camera video
  const hasVideo = participant.isVideoOn && !!participant.videoStream;
  const memberColorScheme = useMemberStore((state) => {
    const member = state.members.find((m) => m.user_id === participant.userId);
    return member?.color_scheme;
  });
  const userColors = useMemo(() => resolveUserAccentColors(memberColorScheme), [memberColorScheme]);
  const { scopeProps } = useUserThemeScope(memberColorScheme);
  const gradient = useMemo(
    () => userColors?.gradient ?? bannerGradient(participant.userId),
    [userColors, participant.userId]
  );

  const scaleStyle =
    magnificationScale !== 1 ? { transform: `scale(${magnificationScale})`, zIndex: 2 } : undefined;

  return (
    <div
      className={`participant-tile${hasVideo ? ' participant-tile--video' : ''}${compact ? ' participant-tile--compact' : ''}`}
      {...scopeProps}
      style={{ ...scopeProps.style, ...scaleStyle }}
    >
      {hasVideo ? (
        /* Video mode — fills the frame, name overlay at bottom */
        <>
          <video ref={videoRef} className="participant-tile__video" autoPlay playsInline muted />
          <div className="participant-tile__video-name">
            <span className="participant-tile__video-name-text">
              {displayName}
              {isLocal && ' (You)'}
            </span>
          </div>
        </>
      ) : (
        /* Default square frame — banner + avatar + name */
        <>
          <div className="participant-tile__banner" style={{ background: gradient }} />
          <div className="participant-tile__body">
            <div className="participant-tile__avatar">
              {participant.avatarUrl ? (
                <img
                  src={participant.avatarUrl}
                  alt={displayName}
                  className="participant-tile__avatar-img"
                />
              ) : (
                <div
                  className="participant-tile__avatar-fallback"
                  style={userColors ? { background: userColors.gradient } : undefined}
                >
                  {displayName.charAt(0).toUpperCase()}
                </div>
              )}
            </div>
            <span className="participant-tile__name">
              {displayName}
              {isLocal && ' (You)'}
            </span>
          </div>
        </>
      )}

      {/* Status overlays */}
      <div className="participant-tile__overlays">
        {participant.isMuted && (
          <div className="participant-tile__status participant-tile__status--muted">
            <MicOff size={compact ? 10 : 14} />
          </div>
        )}
        {participant.isScreenSharing && (
          <div className="participant-tile__status participant-tile__status--screen">
            <Monitor size={compact ? 10 : 14} />
          </div>
        )}
      </div>
    </div>
  );
};

export default React.memo(ParticipantTile);
