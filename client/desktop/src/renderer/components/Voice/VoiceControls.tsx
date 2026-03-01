import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  Mic,
  MicOff,
  Headphones,
  HeadphoneOff,
  Video,
  VideoOff,
  Monitor,
  MonitorOff,
  PhoneOff,
  MessageSquare,
  MessageSquareOff,
  PictureInPicture2,
  Eye,
  EyeOff,
  Pin,
  PinOff,
  ExternalLink,
} from 'lucide-react';
import { useVoiceStore } from '../../stores/voiceStore';
import { useChannelStore } from '../../stores/channelStore';
import { getVoiceService } from '../../services/voiceLazy';
import ScreenSharePicker from './ScreenSharePicker';
import { useDocumentPip } from './useDocumentPip';
import { DocumentPipContent } from './DocumentPipContent';
import './VoiceControls.css';

interface VoiceControlsProps {
  /** 'voiceView' = inside VoiceView, 'persistent' = navigated-away bar */
  context?: 'voiceView' | 'persistent';
  /** Callback to pop out the controls bar (managed by parent PersistentVoiceBar) */
  onPopOut?: () => void;
}

const VoiceControls: React.FC<VoiceControlsProps> = ({ context = 'voiceView', onPopOut }) => {
  const {
    activeChannelId,
    connectionState,
    isMuted,
    isDeafened,
    isVideoOn,
    isScreenSharing,
    showVoiceTextChat,
    toggleVoiceTextChat,
    participants,
    videoSlotError,
    setVideoSlotError,
    tunedInScreenShares,
    keepActiveWhileUnfocused,
    setKeepActiveWhileUnfocused,
    voiceControlsPinned,
    toggleVoiceControlsPinned,
  } = useVoiceStore();

  const getLinkedTextChannel = useChannelStore((s) => s.getLinkedTextChannel);
  const hasLinkedText = !!(activeChannelId && getLinkedTextChannel(activeChannelId));

  const [showScreenPicker, setShowScreenPicker] = useState(false);
  const [showPipMenu, setShowPipMenu] = useState(false);

  const controlsRef = useRef<HTMLDivElement>(null);
  const pipWrapRef = useRef<HTMLDivElement>(null);
  const pipMenuRef = useRef<HTMLDivElement>(null);

  // Document PiP state (for frames/screen pop-out, not controls pop-out)
  const docPip = useDocumentPip();
  const [pipMode, setPipMode] = useState<'frames' | 'screen'>('frames');
  const [pipProducerId, setPipProducerId] = useState('');

  const handleToggleMute = async () => {
    const { voiceService } = await getVoiceService();
    voiceService.toggleMute();
  };

  const handleToggleDeafen = async () => {
    const { voiceService } = await getVoiceService();
    voiceService.toggleDeafen();
  };

  const handleToggleVideo = async () => {
    const { voiceService } = await getVoiceService();
    await voiceService.toggleVideo();
  };

  const handleToggleScreen = async () => {
    try {
      if (isScreenSharing) {
        const { voiceService } = await getVoiceService();
        await voiceService.toggleScreenShare();
      } else {
        if (typeof window.electron?.getDesktopSources === 'function') {
          setShowScreenPicker(true);
        } else {
          const { voiceService } = await getVoiceService();
          await voiceService.toggleScreenShare();
        }
      }
    } catch (err) {
      console.error('Failed to toggle screen share:', err);
    }
  };

  const handleScreenSourceSelected = async (sourceId: string) => {
    setShowScreenPicker(false);
    try {
      const { voiceService } = await getVoiceService();
      await voiceService.toggleScreenShare(sourceId);
    } catch (err) {
      console.error('Failed to start screen share:', err);
    }
  };

  const handleLeave = async () => {
    const { voiceService } = await getVoiceService();
    await voiceService.leaveChannel();
  };

  // Auto-dismiss video slot error after 5 seconds
  useEffect(() => {
    if (!videoSlotError) return;
    const timer = setTimeout(() => setVideoSlotError(null), 5000);
    return () => clearTimeout(timer);
  }, [videoSlotError, setVideoSlotError]);

  // Close PiP menu on click outside or Escape
  useEffect(() => {
    if (!showPipMenu) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (pipWrapRef.current?.contains(target)) return;
      if (pipMenuRef.current?.contains(target)) return;
      setShowPipMenu(false);
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowPipMenu(false);
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [showPipMenu]);

  /** Compute position:fixed style to render a portal element above an anchor */
  const getPortalStyle = (ref: React.RefObject<HTMLElement | null>): React.CSSProperties => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return { position: 'fixed', bottom: 0, left: '50%', transform: 'translateX(-50%)', zIndex: 99999 };
    return {
      position: 'fixed',
      bottom: window.innerHeight - rect.top,
      left: rect.left + rect.width / 2,
      transform: 'translateX(-50%)',
      zIndex: 99999,
    };
  };

  const handleOpenPip = useCallback(async (mode: 'frames' | 'screen', producerId?: string) => {
    if (docPip.isOpen) {
      docPip.close();
    }
    setPipMode(mode);
    setPipProducerId(producerId || '');
    await docPip.open({
      width: mode === 'frames' ? 320 : 400,
      height: mode === 'frames' ? 240 : 300,
    });
    setShowPipMenu(false);
  }, [docPip]);

  const tunedInIds = Object.keys(tunedInScreenShares);

  if (connectionState === 'disconnected') return null;

  return (
    <>
      <div ref={controlsRef} className="voice-controls voice-controls--full">
        {/* Pin/Unpin button — persistent context only */}
        {context === 'persistent' && (
          <div className="voice-controls__persistent-actions">
            <button
              className="voice-controls__pin-btn"
              onClick={toggleVoiceControlsPinned}
              title={voiceControlsPinned ? 'Unpin controls' : 'Pin controls'}
            >
              {voiceControlsPinned ? <PinOff size={14} /> : <Pin size={14} />}
            </button>
          </div>
        )}

        <div className="voice-controls__buttons">
          <button
            className={`voice-controls__btn ${isMuted ? 'voice-controls__btn--active' : ''}`}
            onClick={handleToggleMute}
            title={isMuted ? 'Unmute' : 'Mute'}
          >
            {isMuted ? <MicOff size={18} /> : <Mic size={18} />}
            <span className="voice-controls__btn-label">{isMuted ? 'Unmute' : 'Mute'}</span>
          </button>

          <button
            className={`voice-controls__btn ${isDeafened ? 'voice-controls__btn--active' : ''}`}
            onClick={handleToggleDeafen}
            title={isDeafened ? 'Undeafen' : 'Deafen'}
          >
            {isDeafened ? <HeadphoneOff size={18} /> : <Headphones size={18} />}
            <span className="voice-controls__btn-label">{isDeafened ? 'Undeafen' : 'Deafen'}</span>
          </button>

          <button
            className={`voice-controls__btn ${isVideoOn ? 'voice-controls__btn--active' : ''}`}
            onClick={handleToggleVideo}
            title={isVideoOn ? 'Stop Video' : 'Start Video'}
          >
            {isVideoOn ? <VideoOff size={18} /> : <Video size={18} />}
            <span className="voice-controls__btn-label">{isVideoOn ? 'Stop Video' : 'Video'}</span>
          </button>

          <button
            className={`voice-controls__btn ${isScreenSharing ? 'voice-controls__btn--active' : ''}`}
            onClick={handleToggleScreen}
            title={isScreenSharing ? 'Stop Sharing' : 'Share Screen'}
          >
            {isScreenSharing ? <MonitorOff size={18} /> : <Monitor size={18} />}
            <span className="voice-controls__btn-label">{isScreenSharing ? 'Stop' : 'Screen'}</span>
          </button>

          {hasLinkedText && (
            <button
              className={`voice-controls__btn ${showVoiceTextChat ? 'voice-controls__btn--chat-active' : ''}`}
              onClick={toggleVoiceTextChat}
              title={showVoiceTextChat ? 'Hide Text Chat' : 'Show Text Chat'}
            >
              {showVoiceTextChat ? <MessageSquareOff size={18} /> : <MessageSquare size={18} />}
              <span className="voice-controls__btn-label">Chat</span>
            </button>
          )}

          {isScreenSharing && (
            <button
              className={`voice-controls__btn ${keepActiveWhileUnfocused ? 'voice-controls__btn--active' : ''}`}
              onClick={() => setKeepActiveWhileUnfocused(!keepActiveWhileUnfocused)}
              title={keepActiveWhileUnfocused ? 'Stream stays active when unfocused' : 'Stream pauses when unfocused'}
            >
              {keepActiveWhileUnfocused ? <Eye size={18} /> : <EyeOff size={18} />}
              <span className="voice-controls__btn-label">{keepActiveWhileUnfocused ? 'Always On' : 'Auto Pause'}</span>
            </button>
          )}

          {docPip.isSupported && (
            <div ref={pipWrapRef} className="voice-controls__pip-wrap">
              <button
                className={`voice-controls__btn ${docPip.isOpen ? 'voice-controls__btn--active' : ''}`}
                onClick={() => {
                  if (docPip.isOpen) {
                    docPip.close();
                  } else {
                    setShowPipMenu((v) => !v);
                  }
                }}
                title="Picture-in-Picture"
              >
                <PictureInPicture2 size={18} />
                <span className="voice-controls__btn-label">PiP</span>
              </button>
            </div>
          )}

          {/* Pop-Out controls button — persistent context only */}
          {context === 'persistent' && onPopOut && (
            <button
              className="voice-controls__btn"
              onClick={onPopOut}
              title="Pop out controls"
            >
              <ExternalLink size={18} />
              <span className="voice-controls__btn-label">Pop Out</span>
            </button>
          )}

          <button
            className="voice-controls__btn voice-controls__btn--danger"
            onClick={handleLeave}
            title="Leave Voice"
          >
            <PhoneOff size={18} />
            <span className="voice-controls__btn-label">Leave</span>
          </button>
        </div>
      </div>

      {/* Portaled slot error — escapes overflow:hidden ancestors */}
      {videoSlotError && createPortal(
        <div className="voice-controls__slot-error" style={getPortalStyle(controlsRef)}>
          {videoSlotError}
        </div>,
        document.body
      )}

      {/* Portaled PiP menu — escapes overflow:hidden ancestors */}
      {showPipMenu && !docPip.isOpen && createPortal(
        <div ref={pipMenuRef} className="voice-controls__pip-menu" style={getPortalStyle(pipWrapRef)}>
          <button
            className="voice-controls__pip-menu-item"
            onClick={() => handleOpenPip('frames')}
          >
            Pop Out User Frames
          </button>
          {tunedInIds.map((producerId) => {
            const sharer = Object.values(participants).find(
              (p) => p.isScreenSharing
            );
            const name = sharer?.displayName || sharer?.username || 'User';
            return (
              <button
                key={producerId}
                className="voice-controls__pip-menu-item"
                onClick={() => handleOpenPip('screen', producerId)}
              >
                Pop Out {name}&apos;s Screen
              </button>
            );
          })}
        </div>,
        document.body
      )}

      {showScreenPicker && (
        <ScreenSharePicker
          onSelect={handleScreenSourceSelected}
          onCancel={() => setShowScreenPicker(false)}
        />
      )}

      {/* Render Document PiP content via React Portal */}
      {docPip.isOpen && docPip.pipWindow && (
        <DocumentPipContent
          pipWindow={docPip.pipWindow}
          mode={pipMode}
          producerId={pipProducerId}
        />
      )}
    </>
  );
};

export default VoiceControls;
