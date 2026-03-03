import React, { useRef, useEffect, useCallback } from 'react';
import { ChevronLeft, ChevronRight, PictureInPicture2, LayoutGrid, Focus } from 'lucide-react';
import { useVoiceStore } from '../../stores/voiceStore';
import { useDocumentPip, hasDocumentPipSupport } from './useDocumentPip';
import { DocumentPipContent } from './DocumentPipContent';
import './VoiceStage.css';

/**
 * Single screen share video cell (used in both equal and focus modes).
 */
const StageVideo: React.FC<{
  stream?: MediaStream;
  sharerName: string;
  showOverlay?: boolean;
  label?: string;
}> = ({ stream, sharerName, showOverlay = true, label }) => {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (stream) {
      el.srcObject = stream;
      el.play().catch(() => {});
    } else {
      el.srcObject = null;
    }
    return () => {
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
    };
  }, [stream]);

  return (
    <div className="voice-stage__cell">
      <video
        ref={videoRef}
        className="voice-stage__video"
        autoPlay
        playsInline
        muted
      />
      {showOverlay && (
        <div className="voice-stage__cell-overlay">
          <span className="voice-stage__sharer-name">
            {label || `${sharerName}\u2019s screen`}
          </span>
        </div>
      )}
    </div>
  );
};

/**
 * Center stage for tuned-in screen shares (Mode B — middle section).
 *
 * Two sub-layouts controlled by `stageLayout`:
 * - **equal**: All tuned-in streams displayed in an equal-weight grid
 * - **focus**: Single dominant stream fills the stage; others go to StreamBar
 */
const VoiceStage: React.FC = () => {
  const dominantScreenShareId = useVoiceStore((s) => s.dominantScreenShareId);
  const tunedInScreenShares = useVoiceStore((s) => s.tunedInScreenShares);
  const participants = useVoiceStore((s) => s.participants);
  const setDominantScreenShare = useVoiceStore((s) => s.setDominantScreenShare);
  const stageLayout = useVoiceStore((s) => s.stageLayout);
  const toggleStageLayout = useVoiceStore((s) => s.toggleStageLayout);
  const docPip = useDocumentPip();

  const tunedInIds = Object.keys(tunedInScreenShares);
  const hasMultiple = tunedInIds.length > 1;

  // Helper: find participant who owns a given producerId.
  // For now, each participant has a single screenStream, so we match via
  // the isScreenSharing flag. With multiple sharers this will need a
  // producerId → userId lookup (future enhancement).
  const findSharer = useCallback(
    (_producerId: string) =>
      Object.values(participants).find((p) => p.isScreenSharing && p.screenStream),
    [participants]
  );

  // ── Focus mode helpers ──────────────────────────────────────────────
  const dominantSharer = dominantScreenShareId ? findSharer(dominantScreenShareId) : null;

  const cycle = useCallback(
    (direction: 1 | -1) => {
      if (!hasMultiple || !dominantScreenShareId) return;
      const idx = tunedInIds.indexOf(dominantScreenShareId);
      const nextIdx = (idx + direction + tunedInIds.length) % tunedInIds.length;
      setDominantScreenShare(tunedInIds[nextIdx]);
    },
    [hasMultiple, dominantScreenShareId, tunedInIds, setDominantScreenShare]
  );

  // Keyboard navigation (focus mode only)
  useEffect(() => {
    if (stageLayout !== 'focus' || !hasMultiple) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') cycle(-1);
      if (e.key === 'ArrowRight') cycle(1);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [stageLayout, hasMultiple, cycle]);

  // ── Empty state ─────────────────────────────────────────────────────
  if (tunedInIds.length === 0) {
    return (
      <div className="voice-stage voice-stage--empty">
        <span className="voice-stage__empty-text">
          No screen share selected
        </span>
      </div>
    );
  }

  const dominantSharerName = dominantSharer?.displayName || dominantSharer?.username || 'Unknown';

  // ── Equal mode: grid of all tuned-in streams ────────────────────────
  if (stageLayout === 'equal') {
    return (
      <div className="voice-stage voice-stage--equal">
        {/* Layout toggle (top-left) */}
        {hasMultiple && (
          <button
            className="voice-stage__layout-toggle"
            onClick={toggleStageLayout}
            title="Switch to focus mode"
          >
            <Focus size={16} />
          </button>
        )}

        <div
          className="voice-stage__grid"
          data-count={tunedInIds.length}
        >
          {tunedInIds.map((producerId) => {
            const sharer = findSharer(producerId);
            const name = sharer?.displayName || sharer?.username || 'Unknown';
            return (
              <StageVideo
                key={producerId}
                stream={sharer?.screenStream}
                sharerName={name}
              />
            );
          })}
        </div>
      </div>
    );
  }

  // ── Focus mode: single dominant stream ──────────────────────────────
  return (
    <div className="voice-stage">
      <StageVideo
        stream={dominantSharer?.screenStream}
        sharerName={dominantSharerName}
        showOverlay={false}
      />

      {/* Bottom overlay */}
      <div className="voice-stage__overlay">
        <span className="voice-stage__sharer-name">
          {dominantSharerName}&apos;s screen
        </span>
        {hasMultiple && (
          <span className="voice-stage__count">
            {tunedInIds.indexOf(dominantScreenShareId!) + 1} / {tunedInIds.length}
          </span>
        )}
      </div>

      {/* Layout toggle (top-left) */}
      {hasMultiple && (
        <button
          className="voice-stage__layout-toggle"
          onClick={toggleStageLayout}
          title="Switch to equal layout"
        >
          <LayoutGrid size={16} />
        </button>
      )}

      {/* PiP button (top-right) */}
      {hasDocumentPipSupport && dominantScreenShareId && (
        <button
          className="voice-stage__pip-btn"
          onClick={async () => {
            if (docPip.isOpen) {
              docPip.close();
            } else {
              await docPip.open({ width: 400, height: 300 });
            }
          }}
          title={docPip.isOpen ? 'Close PiP' : 'Pop out to PiP window'}
        >
          <PictureInPicture2 size={16} />
        </button>
      )}

      {/* Document PiP portal for screen share */}
      {docPip.isOpen && docPip.pipWindow && (
        <DocumentPipContent
          pipWindow={docPip.pipWindow}
          mode="screen"
          producerId={dominantScreenShareId || ''}
        />
      )}

      {/* Cycle buttons (only when multiple shares in focus mode) */}
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
