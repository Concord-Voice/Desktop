import React, { useRef, useEffect, useCallback } from 'react';
import { ChevronLeft, ChevronRight, PictureInPicture2 } from 'lucide-react';
import { useVoiceStore } from '../../stores/voiceStore';
import './VoiceStage.css';

/**
 * Center stage for the dominant screen share (Mode B — middle section).
 * Shows the active screen share full-size with letterboxing.
 * Supports cycling through multiple tuned-in shares.
 */
const VoiceStage: React.FC = () => {
  const dominantScreenShareId = useVoiceStore((s) => s.dominantScreenShareId);
  const tunedInScreenShares = useVoiceStore((s) => s.tunedInScreenShares);
  const participants = useVoiceStore((s) => s.participants);
  const setDominantScreenShare = useVoiceStore((s) => s.setDominantScreenShare);
  const addPipWindow = useVoiceStore((s) => s.addPipWindow);
  const pipWindows = useVoiceStore((s) => s.pipWindows);
  const hasPipSupport = !!window.electron?.openPipWindow;
  const videoRef = useRef<HTMLVideoElement>(null);

  const tunedInIds = Object.keys(tunedInScreenShares);
  const hasMultiple = tunedInIds.length > 1;

  // Find the participant sharing the dominant screen
  const sharer = dominantScreenShareId
    ? Object.values(participants).find(
        (p) => p.isScreenSharing && p.screenStream
      )
    : null;

  // Attach the dominant screen share stream
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;

    if (sharer?.screenStream) {
      el.srcObject = sharer.screenStream;
      el.play().catch(() => {});
    } else {
      el.srcObject = null;
    }

    return () => {
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
    };
  }, [sharer?.screenStream]);

  // Cycle to the next/previous dominant share
  const cycle = useCallback(
    (direction: 1 | -1) => {
      if (!hasMultiple || !dominantScreenShareId) return;
      const idx = tunedInIds.indexOf(dominantScreenShareId);
      const nextIdx = (idx + direction + tunedInIds.length) % tunedInIds.length;
      setDominantScreenShare(tunedInIds[nextIdx]);
    },
    [hasMultiple, dominantScreenShareId, tunedInIds, setDominantScreenShare]
  );

  // Keyboard navigation
  useEffect(() => {
    if (!hasMultiple) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') cycle(-1);
      if (e.key === 'ArrowRight') cycle(1);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [hasMultiple, cycle]);

  if (!dominantScreenShareId) {
    return (
      <div className="voice-stage voice-stage--empty">
        <span className="voice-stage__empty-text">
          No screen share selected
        </span>
      </div>
    );
  }

  const sharerName = sharer?.displayName || sharer?.username || 'Unknown';

  return (
    <div className="voice-stage">
      <video
        ref={videoRef}
        className="voice-stage__video"
        autoPlay
        playsInline
        muted
      />

      {/* Bottom overlay */}
      <div className="voice-stage__overlay">
        <span className="voice-stage__sharer-name">
          {sharerName}&apos;s screen
        </span>
        {hasMultiple && (
          <span className="voice-stage__count">
            {tunedInIds.indexOf(dominantScreenShareId) + 1} / {tunedInIds.length}
          </span>
        )}
      </div>

      {/* PiP button (top-right) */}
      {hasPipSupport && dominantScreenShareId && (
        <button
          className="voice-stage__pip-btn"
          onClick={() => {
            const pipId = `screen-${dominantScreenShareId}`;
            if (!pipWindows.includes(pipId)) {
              window.electron?.openPipWindow({
                id: pipId,
                title: `${sharerName}'s Screen`,
                width: 400,
                height: 300,
              });
              addPipWindow(pipId);
            }
          }}
          title="Pop out to PiP window"
          disabled={pipWindows.includes(`screen-${dominantScreenShareId}`)}
        >
          <PictureInPicture2 size={16} />
        </button>
      )}

      {/* Cycle buttons (only when multiple shares) */}
      {hasMultiple && (
        <>
          <button
            className="voice-stage__nav voice-stage__nav--prev"
            onClick={() => cycle(-1)}
            title="Previous screen share (←)"
          >
            <ChevronLeft size={20} />
          </button>
          <button
            className="voice-stage__nav voice-stage__nav--next"
            onClick={() => cycle(1)}
            title="Next screen share (→)"
          >
            <ChevronRight size={20} />
          </button>
        </>
      )}
    </div>
  );
};

export default VoiceStage;
