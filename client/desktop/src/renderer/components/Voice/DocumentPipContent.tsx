import React, { useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useVoiceStore } from '../../stores/voiceStore';
import { useUserStore } from '../../stores/userStore';
import ParticipantTile from './ParticipantTile';
import VoiceControls from './VoiceControls';
import { useVoiceMagnification } from './useVoiceMagnification';

interface DocumentPipContentProps {
  pipWindow: Window;
  mode: 'frames' | 'screen' | 'controls';
  /** For screen mode: the producerId of the screen share to display */
  producerId?: string;
}

/**
 * Renders voice content into a Document PiP window via React Portal.
 *
 * Because the Document PiP API shares the same browsing context,
 * we can access the Zustand store and MediaStream objects directly —
 * no serialization or BroadcastChannel needed.
 */
export const DocumentPipContent: React.FC<DocumentPipContentProps> = ({
  pipWindow,
  mode,
  producerId,
}) => {
  if (mode === 'controls') {
    return <ControlsPipPortal pipWindow={pipWindow} />;
  }
  if (mode === 'frames') {
    return <FramesPipPortal pipWindow={pipWindow} />;
  }
  return <ScreenPipPortal pipWindow={pipWindow} producerId={producerId || ''} />;
};

/**
 * Controls PiP — voice controls in a floating window.
 * Uses context="voiceView" to avoid recursive pin/pop-out buttons.
 */
const ControlsPipPortal: React.FC<{ pipWindow: Window }> = ({ pipWindow }) => {
  return createPortal(
    <div className="pip-window pip-window--controls">
      <VoiceControls />
    </div>,
    pipWindow.document.body
  );
};

/**
 * User Frames PiP — all participants in a compact grid with live video.
 */
const FramesPipPortal: React.FC<{ pipWindow: Window }> = ({ pipWindow }) => {
  const participants = useVoiceStore((s) => s.participants);
  const localUserId = useUserStore((s) => s.user?.id);
  const scales = useVoiceMagnification(participants);
  const participantList = Object.values(participants);

  return createPortal(
    <div className="pip-window">
      <div className="pip-frames-grid">
        {participantList.map((p) => (
          <ParticipantTile
            key={p.userId}
            participant={p}
            isLocal={p.userId === localUserId}
            compact
            magnificationScale={scales[p.userId]}
          />
        ))}
        {participantList.length === 0 && (
          <div className="pip-empty">No participants</div>
        )}
      </div>
    </div>,
    pipWindow.document.body
  );
};

/**
 * Screen Share PiP — a single screen share video, rendered with the
 * real MediaStream from the shared browsing context.
 */
const ScreenPipPortal: React.FC<{ pipWindow: Window; producerId: string }> = ({
  pipWindow,
  producerId,
}) => {
  const participants = useVoiceStore((s) => s.participants);
  const tunedInScreenShares = useVoiceStore((s) => s.tunedInScreenShares);

  // Find the participant whose screen share matches the producerId
  const sharerEntry = Object.entries(participants).find(([, p]) => {
    if (!p.isScreenSharing || !p.screenStream) return false;
    // Check if any tuned-in share maps to this participant
    return Object.keys(tunedInScreenShares).includes(producerId);
  });

  const sharer = sharerEntry?.[1];

  return createPortal(
    <div className="pip-window pip-window--screen">
      {sharer?.screenStream ? (
        <ScreenVideo stream={sharer.screenStream} />
      ) : (
        <div className="pip-screen-placeholder">
          <span className="pip-screen-placeholder__text">Screen share ended</span>
        </div>
      )}
    </div>,
    pipWindow.document.body
  );
};

/** Renders a <video> element attached to a MediaStream */
const ScreenVideo: React.FC<{ stream: MediaStream }> = ({ stream }) => {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.srcObject = stream;
    el.play().catch(() => {});
    return () => {
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, [stream]);

  return (
    <video
      ref={videoRef}
      autoPlay
      playsInline
      muted
      style={{ width: '100%', height: '100%', objectFit: 'contain', background: '#000' }}
    />
  );
};
