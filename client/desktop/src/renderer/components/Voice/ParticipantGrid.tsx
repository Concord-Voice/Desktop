import React, { useRef, useEffect } from 'react';
import { useVoiceStore } from '../../stores/voiceStore';
import { useUserStore } from '../../stores/userStore';
import ParticipantTile from './ParticipantTile';
import './ParticipantGrid.css';

/**
 * Hidden audio element that plays a remote participant's audio stream.
 * One <audio> per remote participant — local user is excluded (no echo).
 */
const AudioOutput: React.FC<{ stream: MediaStream; outputDeviceId?: string }> = ({
  stream,
  outputDeviceId,
}) => {
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    el.srcObject = stream;

    // Explicit play() — autoPlay attribute alone can be blocked by Chromium's
    // autoplay policy in some edge cases (dynamic element creation, etc.)
    el.play().catch(() => {});

    // Set output device if available (Chrome/Electron setSinkId)
    if (outputDeviceId && 'setSinkId' in el) {
      (el as HTMLAudioElement & { setSinkId: (id: string) => Promise<void> })
        .setSinkId(outputDeviceId)
        .catch((err) => console.warn('Failed to set audio output device:', err));
    }

    return () => {
      el.srcObject = null;
    };
  }, [stream, outputDeviceId]);

  return <audio ref={audioRef} autoPlay playsInline />;
};

const ParticipantGrid: React.FC = () => {
  const participants = useVoiceStore((s) => s.participants);
  const localUserId = useUserStore((s) => s.user?.id);
  const audioOutputDeviceId = useVoiceStore((s) => s.audioOutputDeviceId);
  const screenShareRef = useRef<HTMLVideoElement>(null);

  const participantList = Object.values(participants);
  const count = participantList.length;

  // Find active screen share (first one found)
  const screenSharer = participantList.find((p) => p.isScreenSharing && p.screenStream);

  // Attach screen share stream
  useEffect(() => {
    const el = screenShareRef.current;
    if (el && screenSharer?.screenStream) {
      el.srcObject = screenSharer.screenStream;
      el.play().catch(() => {});
    }
    return () => {
      if (screenShareRef.current) {
        screenShareRef.current.srcObject = null;
      }
    };
  }, [screenSharer?.screenStream]);

  // Determine grid layout class based on participant count
  const getGridClass = () => {
    if (screenSharer) return 'participant-grid--screen-share';
    if (count === 1) return 'participant-grid--solo';
    if (count === 2) return 'participant-grid--duo';
    if (count <= 4) return 'participant-grid--quad';
    return 'participant-grid--many';
  };

  return (
    <div className={`participant-grid ${getGridClass()}`}>
      {/* Hidden audio elements for remote participants */}
      {participantList
        .filter((p) => p.userId !== localUserId && p.audioStream)
        .map((p) => (
          <AudioOutput
            key={`audio-${p.userId}`}
            stream={p.audioStream!}
            outputDeviceId={audioOutputDeviceId || undefined}
          />
        ))}

      {/* Screen share takes priority — shown as large tile */}
      {screenSharer && (
        <div className="participant-grid__screen-share">
          <video
            ref={screenShareRef}
            className="participant-grid__screen-video"
            autoPlay
            playsInline
            muted
          />
          <div className="participant-grid__screen-label">
            {screenSharer.displayName || screenSharer.username}'s screen
          </div>
        </div>
      )}

      {/* Participant tiles */}
      <div className={`participant-grid__tiles ${screenSharer ? 'participant-grid__tiles--strip' : ''}`}>
        {participantList.map((p) => (
          <ParticipantTile
            key={p.userId}
            participant={p}
            isLocal={p.userId === localUserId}
            size={screenSharer ? 'small' : count <= 2 ? 'large' : 'normal'}
          />
        ))}
      </div>
    </div>
  );
};

export default ParticipantGrid;
