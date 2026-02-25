import React, { useRef, useEffect } from 'react';
import { useVoiceStore } from '../../stores/voiceStore';
import { useUserStore } from '../../stores/userStore';
import ParticipantTile from './ParticipantTile';
import { useVoiceMagnification } from './useVoiceMagnification';
import './ParticipantGrid.css';

/**
 * Hidden audio element that plays a remote participant's audio stream.
 * One <audio> per remote participant — local user is excluded (no echo).
 */
export const AudioOutput: React.FC<{ stream: MediaStream; outputDeviceId?: string }> = ({
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

/**
 * Audio outputs for all remote participants (hidden <audio> elements).
 * Separated so they can be rendered independently of the visual layout.
 */
export const AudioOutputs: React.FC = () => {
  const participants = useVoiceStore((s) => s.participants);
  const localUserId = useUserStore((s) => s.user?.id);
  const audioOutputDeviceId = useVoiceStore((s) => s.audioOutputDeviceId);
  const participantList = Object.values(participants);

  return (
    <>
      {participantList
        .filter((p) => p.userId !== localUserId && p.audioStream)
        .map((p) => (
          <AudioOutput
            key={`audio-${p.userId}`}
            stream={p.audioStream!}
            outputDeviceId={audioOutputDeviceId || undefined}
          />
        ))}
    </>
  );
};

/**
 * Mode A layout: centered user frames grid with no scrollbars.
 * Tiles scale dynamically to fit the viewport.
 */
export const UserFrameGrid: React.FC = () => {
  const participants = useVoiceStore((s) => s.participants);
  const localUserId = useUserStore((s) => s.user?.id);
  const participantList = Object.values(participants);
  const scales = useVoiceMagnification(participants);

  return (
    <div className="user-frame-grid">
      {participantList.map((p) => (
        <ParticipantTile
          key={p.userId}
          participant={p}
          isLocal={p.userId === localUserId}
          magnificationScale={scales[p.userId]}
        />
      ))}
    </div>
  );
};

/**
 * ParticipantGrid — orchestrator for voice visual layout.
 * Renders AudioOutputs + the appropriate visual layout mode.
 * Will be replaced by VoiceView integration in Phase 4.
 */
const ParticipantGrid: React.FC = () => {
  return (
    <>
      <AudioOutputs />
      <UserFrameGrid />
    </>
  );
};

export default ParticipantGrid;
