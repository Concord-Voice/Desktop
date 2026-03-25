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
import { useOsPermissionStore } from '../../stores/osPermissionStore';
// voiceService is loaded on-demand via dynamic import() — see voiceService.ts
import ScreenSharePicker from './ScreenSharePicker';
import './VoiceControls.css';

/**
 * JIT permission pre-check: verify an OS permission before starting a media action.
 * Returns true if permission was denied (caller should abort).
 */
async function checkPermissionOrWarn(
  permType: 'camera' | 'screen',
  errorMessage: string
): Promise<boolean> {
  const permStore = useOsPermissionStore.getState();
  const status = await permStore.checkOne(permType);
  if (status === 'denied' || status === 'restricted') {
    useVoiceStore.getState().setVideoSlotError(errorMessage);
    permStore.openSettings(permType);
    return true;
  }
  return false;
}

/** Lazily import and return the voice service. */
async function getVoiceService() {
  const { voiceService } = await import('../../services/voiceService');
  return voiceService;
}

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

  // Electron PiP — check if electron API is available
  const hasElectronPip = !!globalThis.electron?.openPipWindow;

  const handleToggleMute = async () => {
    (await getVoiceService()).toggleMute();
  };

  const handleToggleDeafen = async () => {
    (await getVoiceService()).toggleDeafen();
  };

  const handleToggleVideo = async () => {
    if (!isVideoOn) {
      const denied = await checkPermissionOrWarn(
        'camera',
        'Camera access denied. Grant permission in System Settings > Privacy & Security.'
      );
      if (denied) return;
    }
    await (await getVoiceService()).toggleVideo();
  };

  const handleToggleScreen = async () => {
    try {
      if (isScreenSharing) {
        await (await getVoiceService()).toggleScreenShare();
        return;
      }

      const denied = await checkPermissionOrWarn(
        'screen',
        'Screen recording access denied. On macOS, enable Screen Recording in ' +
          'System Settings > Privacy & Security, then restart Concord.'
      );
      if (denied) return;

      if (typeof globalThis.electron?.getDesktopSources === 'function') {
        setShowScreenPicker(true);
      } else {
        await (await getVoiceService()).toggleScreenShare();
      }
    } catch (err) {
      console.error('Failed to toggle screen share:', err);
    }
  };

  const handleScreenSourceSelected = async (
    sourceId: string,
    options?: import('../../stores/videoSettingsStore').ScreenShareOptions
  ) => {
    setShowScreenPicker(false);
    try {
      await (await getVoiceService()).toggleScreenShare(sourceId, options);
    } catch (err) {
      console.error('Failed to start screen share:', err);
    }
  };

  const handleLeave = async () => {
    await (await getVoiceService()).leaveChannel();
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
    if (!rect)
      return {
        position: 'fixed',
        bottom: 0,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 99999,
      };
    return {
      position: 'fixed',
      bottom: globalThis.innerHeight - rect.top,
      left: rect.left + rect.width / 2,
      transform: 'translateX(-50%)',
      zIndex: 99999,
    };
  };

  const handleOpenPip = useCallback(async (mode: 'frames' | 'screen', producerId?: string) => {
    if (!globalThis.electron?.openPipWindow) return;
    const id = mode === 'frames' ? 'frames-main' : `screen-${producerId || ''}`;
    await globalThis.electron.openPipWindow({
      id,
      width: mode === 'frames' ? 320 : 400,
      height: mode === 'frames' ? 240 : 300,
    });
    setShowPipMenu(false);
  }, []);

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
              title={
                keepActiveWhileUnfocused
                  ? 'Stream stays active when unfocused'
                  : 'Stream pauses when unfocused'
              }
            >
              {keepActiveWhileUnfocused ? <Eye size={18} /> : <EyeOff size={18} />}
              <span className="voice-controls__btn-label">
                {keepActiveWhileUnfocused ? 'Always On' : 'Auto Pause'}
              </span>
            </button>
          )}

          {hasElectronPip && (
            <div ref={pipWrapRef} className="voice-controls__pip-wrap">
              <button
                className="voice-controls__btn"
                onClick={() => setShowPipMenu((v) => !v)}
                title="Picture-in-Picture"
              >
                <PictureInPicture2 size={18} />
                <span className="voice-controls__btn-label">PiP</span>
              </button>
            </div>
          )}

          {/* Pop-Out controls button — persistent context only */}
          {context === 'persistent' && onPopOut && (
            <button className="voice-controls__btn" onClick={onPopOut} title="Pop out controls">
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
      {videoSlotError &&
        createPortal(
          <div className="voice-controls__slot-error" style={getPortalStyle(controlsRef)}>
            {videoSlotError}
          </div>,
          document.body
        )}

      {/* Portaled PiP menu — escapes overflow:hidden ancestors */}
      {showPipMenu &&
        createPortal(
          <div
            ref={pipMenuRef}
            className="voice-controls__pip-menu"
            style={getPortalStyle(pipWrapRef)}
          >
            <button
              className="voice-controls__pip-menu-item"
              onClick={() => handleOpenPip('frames')}
            >
              Pop Out User Frames
            </button>
            {tunedInIds.map((producerId) => {
              const sharer = Object.values(participants).find((p) => p.isScreenSharing);
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
    </>
  );
};

export default VoiceControls;
