import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { Pin, PinOff, X } from 'lucide-react';
import type { VoiceParticipant } from '../../stores/voiceStore';
import ParticipantTile from './ParticipantTile';
import { useVoiceMagnification } from './useVoiceMagnification';
import './PipWindow.css';

// BroadcastChannel message types
interface PipStateMessage {
  type: 'pip-state';
  participants: Record<string, VoiceParticipant>;
}

interface PipScreenMessage {
  type: 'pip-screen';
  producerId: string;
  // Stream can't be sent via BroadcastChannel — screen PiP shares the same
  // mediasoup consumer in the main renderer process. For true PiP of screen
  // shares, the main window captures the video element to a canvas and sends
  // frames. For now, screen PiP shows a placeholder message.
}

type PipMessage = PipStateMessage | PipScreenMessage;

/**
 * PiP window content. Two modes based on pipId prefix:
 * - "frames-*": User Frames PiP — compact dynamic grid of all participants
 * - "screen-*": Screen Share PiP — single screen share (placeholder for now)
 */
const PipWindow: React.FC = () => {
  const { pipId } = useParams<{ pipId: string }>();
  const [participants, setParticipants] = useState<Record<string, VoiceParticipant>>({});
  const [pinned, setPinned] = useState(true);
  const channelRef = useRef<BroadcastChannel | null>(null);

  const isFramesPip = pipId?.startsWith('frames');
  const isScreenPip = pipId?.startsWith('screen');

  // Listen for state updates from main renderer
  useEffect(() => {
    const bc = new BroadcastChannel('concord-pip');
    channelRef.current = bc;

    bc.onmessage = (event: MessageEvent<PipMessage>) => {
      const msg = event.data;
      if (msg.type === 'pip-state') {
        setParticipants(msg.participants);
      }
    };

    // Request initial state
    bc.postMessage({ type: 'pip-request-state' });

    return () => {
      bc.close();
      channelRef.current = null;
    };
  }, []);

  // Toggle always-on-top
  const togglePin = useCallback(() => {
    const next = !pinned;
    setPinned(next);
    window.electron?.setPipAlwaysOnTop(pipId || '', next);
  }, [pinned, pipId]);

  // Close this PiP window
  const handleClose = useCallback(() => {
    window.electron?.closePipWindow(pipId || '');
  }, [pipId]);

  if (isFramesPip) {
    return <FramesPipContent participants={participants} pinned={pinned} onTogglePin={togglePin} onClose={handleClose} />;
  }

  if (isScreenPip) {
    return <ScreenPipContent pipId={pipId || ''} pinned={pinned} onTogglePin={togglePin} onClose={handleClose} />;
  }

  return <div className="pip-window">Unknown PiP type</div>;
};

/**
 * User Frames PiP — all participants in a compact grid.
 */
const FramesPipContent: React.FC<{
  participants: Record<string, VoiceParticipant>;
  pinned: boolean;
  onTogglePin: () => void;
  onClose: () => void;
}> = ({ participants, pinned, onTogglePin, onClose }) => {
  const scales = useVoiceMagnification(participants);
  const participantList = Object.values(participants);

  return (
    <div className="pip-window">
      <PipHeader pinned={pinned} onTogglePin={onTogglePin} onClose={onClose} />
      <div className="pip-frames-grid">
        {participantList.map((p) => (
          <ParticipantTile
            key={p.userId}
            participant={p}
            compact
            magnificationScale={scales[p.userId]}
          />
        ))}
        {participantList.length === 0 && (
          <div className="pip-empty">No participants</div>
        )}
      </div>
    </div>
  );
};

/**
 * Screen Share PiP — single screen share video.
 * Note: MediaStream objects can't be sent via BroadcastChannel,
 * so true video PiP requires canvas capture or shared memory.
 * For now, shows an informational placeholder.
 */
const ScreenPipContent: React.FC<{
  pipId: string;
  pinned: boolean;
  onTogglePin: () => void;
  onClose: () => void;
}> = ({ pipId: _pipId, pinned, onTogglePin, onClose }) => {
  return (
    <div className="pip-window pip-window--screen">
      <PipHeader pinned={pinned} onTogglePin={onTogglePin} onClose={onClose} />
      <div className="pip-screen-placeholder">
        <span className="pip-screen-placeholder__text">
          Screen share PiP
        </span>
        <span className="pip-screen-placeholder__sub">
          View this stream in the main window
        </span>
      </div>
    </div>
  );
};

/**
 * Frameless window header with drag region, pin toggle, and close.
 */
const PipHeader: React.FC<{
  pinned: boolean;
  onTogglePin: () => void;
  onClose: () => void;
}> = ({ pinned, onTogglePin, onClose }) => (
  <div className="pip-header">
    <div className="pip-header__drag" />
    <button
      className={`pip-header__btn ${pinned ? 'pip-header__btn--active' : ''}`}
      onClick={onTogglePin}
      title={pinned ? 'Unpin from top' : 'Pin to top'}
    >
      {pinned ? <Pin size={12} /> : <PinOff size={12} />}
    </button>
    <button
      className="pip-header__btn pip-header__btn--close"
      onClick={onClose}
      title="Close PiP"
    >
      <X size={12} />
    </button>
  </div>
);

export default PipWindow;
