import React, { useRef, useEffect } from 'react';
import { useVoiceStore } from '../../stores/voiceStore';
import { useUserStore } from '../../stores/userStore';
import ParticipantTile from './ParticipantTile';
import './ParticipantGrid.css';

const ParticipantGrid: React.FC = () => {
  const participants = useVoiceStore((s) => s.participants);
  const localUserId = useUserStore((s) => s.user?.id);
  const screenShareRef = useRef<HTMLVideoElement>(null);

  const participantList = Object.values(participants);
  const count = participantList.length;

  // Find active screen share (first one found)
  const screenSharer = participantList.find((p) => p.isScreenSharing && p.screenStream);

  // Attach screen share stream
  useEffect(() => {
    if (screenShareRef.current && screenSharer?.screenStream) {
      screenShareRef.current.srcObject = screenSharer.screenStream;
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
      {/* Screen share takes priority — shown as large tile */}
      {screenSharer && (
        <div className="participant-grid__screen-share">
          <video
            ref={screenShareRef}
            className="participant-grid__screen-video"
            autoPlay
            playsInline
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
