import React, { useRef, useEffect, useMemo, useState } from 'react';
import { MicOff, HeadphoneOff, Lock, Monitor, MoreVertical } from 'lucide-react';
import { ParticipantContextMenu } from './ParticipantContextMenu';
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
    hash = Math.trunc((hash << 5) - hash + (userId.codePointAt(i) ?? 0));
  }
  const hue1 = (hash >>> 0) % 360;
  const hue2 = (hue1 + 60) % 360;
  return `linear-gradient(135deg, hsl(${hue1}, 60%, 35%), hsl(${hue2}, 60%, 25%))`;
}

function ParticipantStatusOverlay({
  participant,
  compact,
}: Readonly<{ participant: VoiceParticipant; compact: boolean }>) {
  const iconSize = compact ? 10 : 14;
  const lockSize = compact ? 6 : 8;

  if (participant.serverDeafened) {
    return (
      <div
        className="participant-tile__status participant-tile__status--server-deafened"
        title="Server Deafened"
      >
        <HeadphoneOff size={iconSize} />
        <Lock size={lockSize} className="participant-tile__lock-badge" />
      </div>
    );
  }
  if (participant.serverMuted) {
    return (
      <div
        className="participant-tile__status participant-tile__status--server-muted"
        title="Server Muted"
      >
        <MicOff size={iconSize} />
        <Lock size={lockSize} className="participant-tile__lock-badge" />
      </div>
    );
  }
  if (participant.isDeafened) {
    return (
      <div className="participant-tile__status participant-tile__status--deafened">
        <HeadphoneOff size={iconSize} />
      </div>
    );
  }
  if (participant.isMuted) {
    return (
      <div className="participant-tile__status participant-tile__status--muted">
        <MicOff size={iconSize} />
      </div>
    );
  }
  return null;
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
      // Copy ref value to a local so cleanup acts on the element from setup,
      // not whatever videoRef.current might point at when cleanup runs.
      if (el) {
        el.srcObject = null;
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
    magnificationScale === 1 ? undefined : { transform: `scale(${magnificationScale})`, zIndex: 2 };

  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);

  const handleContextMenu = (e: React.MouseEvent) => {
    // Always stop the browser default + propagation so right-clicks on a tile
    // don't bubble up to the channel/voice-channel context menu. Local users
    // don't get their own menu, but we still swallow the event.
    e.preventDefault();
    e.stopPropagation();
    if (isLocal) return;
    setCtxMenu({ x: e.clientX, y: e.clientY });
  };

  // Keyboard equivalent for the right-click menu: a native <button> trigger
  // rendered at the tile's corner. The button gets Enter/Space + focus for
  // free from native semantics — no role/tabIndex/onKeyDown on the outer div.
  const handleMenuButtonClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setCtxMenu({ x: rect.left, y: rect.bottom });
  };

  return (
    <div
      className={`participant-tile${hasVideo ? ' participant-tile--video' : ''}${compact ? ' participant-tile--compact' : ''}`}
      {...scopeProps}
      style={{ ...scopeProps.style, ...scaleStyle }}
      onContextMenu={handleContextMenu}
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
        <ParticipantStatusOverlay participant={participant} compact={compact} />
        {participant.isScreenSharing && (
          <div className="participant-tile__status participant-tile__status--screen">
            <Monitor size={compact ? 10 : 14} />
          </div>
        )}
      </div>
      {!isLocal && (
        <button
          type="button"
          className="participant-tile__menu-trigger"
          onClick={handleMenuButtonClick}
          aria-haspopup="menu"
          aria-label={`Open menu for ${displayName}`}
        >
          <MoreVertical size={14} aria-hidden="true" />
        </button>
      )}
      {ctxMenu && (
        <ParticipantContextMenu
          participant={participant}
          position={ctxMenu}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  );
};

export default React.memo(ParticipantTile);
