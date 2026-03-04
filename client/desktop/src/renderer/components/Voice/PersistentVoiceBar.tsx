import React, { useRef, useCallback, useEffect } from 'react';
import { useVoiceStore } from '../../stores/voiceStore';
import { useChannelStore } from '../../stores/channelStore';
import VoiceControls from './VoiceControls';
import VoiceTextChat from './VoiceTextChat';
import './PersistentVoiceBar.css';

const MIN_CHAT_HEIGHT = 150;
const MAX_CHAT_RATIO = 0.7;

/**
 * Persistent voice controls bar rendered at the bottom of the chat area
 * when the user is in voice but viewing a different channel.
 *
 * Includes: full VoiceControls, optional text chat drawer, pin/unpin,
 * and pop-out to Electron PiP window.
 *
 * In vertical layout mode, the text chat panel is rendered by MainView
 * as a side column instead of inside this bar.
 */
const PersistentVoiceBar: React.FC = () => {
  const {
    activeChannelId,
    voiceControlsPinned,
    voiceControlsPoppedOut,
    setVoiceControlsPoppedOut,
    showVoiceTextChat,
    voiceTextChatLayout,
    persistentTextChatHeight,
    setPersistentTextChatHeight,
  } = useVoiceStore();

  const getLinkedTextChannel = useChannelStore((s) => s.getLinkedTextChannel);
  const hasLinkedText = !!(activeChannelId && getLinkedTextChannel(activeChannelId));
  const isVertical = voiceTextChatLayout === 'vertical';
  // In vertical mode, the text chat is rendered as a side panel by MainView
  const showChat = showVoiceTextChat && hasLinkedText && !isVertical;

  const containerRef = useRef<HTMLDivElement>(null);
  const resizingRef = useRef(false);

  // Electron PiP for pop-out controls
  const handlePopOut = useCallback(async () => {
    if (!window.electron?.openPipWindow) return;

    await window.electron.openPipWindow({
      id: 'controls-main',
      width: 480,
      height: 80,
      title: 'Concord Voice Controls',
    });
    setVoiceControlsPoppedOut(true);
  }, [setVoiceControlsPoppedOut]);

  // Listen for PiP close to restore inline bar
  useEffect(() => {
    if (!voiceControlsPoppedOut) return;
    const cleanup = window.electron?.onPipClosed?.((closedId: string) => {
      if (closedId === 'controls-main') {
        setVoiceControlsPoppedOut(false);
      }
    });
    return () => {
      cleanup?.();
    };
  }, [voiceControlsPoppedOut, setVoiceControlsPoppedOut]);

  // Resize handler for text chat drawer (horizontal only)
  const handleChatResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      resizingRef.current = true;
      const startY = e.clientY;
      const startHeight = persistentTextChatHeight;

      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';

      const onMouseMove = (moveEvent: MouseEvent) => {
        if (!resizingRef.current || !containerRef.current) return;
        const parentRect = containerRef.current.parentElement?.getBoundingClientRect();
        const maxHeight = parentRect ? parentRect.height * MAX_CHAT_RATIO : 600;
        const delta = startY - moveEvent.clientY;
        const newHeight = Math.min(maxHeight, Math.max(MIN_CHAT_HEIGHT, startHeight + delta));
        setPersistentTextChatHeight(newHeight);
      };

      const onMouseUp = () => {
        resizingRef.current = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    },
    [persistentTextChatHeight, setPersistentTextChatHeight]
  );

  // When popped out to Electron PiP, hide the inline bar
  if (voiceControlsPoppedOut) {
    return null;
  }

  return (
    <div
      ref={containerRef}
      className={`persistent-voice-bar ${voiceControlsPinned ? 'persistent-voice-bar--pinned' : 'persistent-voice-bar--unpinned'}`}
    >
      {/* Text chat drawer (above controls) */}
      {showChat && voiceControlsPinned && (
        <>
          <div className="persistent-voice-bar__chat-resize" onMouseDown={handleChatResizeStart}>
            <div className="persistent-voice-bar__chat-resize-grip" />
          </div>
          <div
            className="persistent-voice-bar__chat-drawer"
            style={{ height: persistentTextChatHeight }}
          >
            <VoiceTextChat />
          </div>
        </>
      )}

      {/* Full controls bar */}
      <VoiceControls
        context="persistent"
        onPopOut={window.electron?.openPipWindow ? handlePopOut : undefined}
      />
    </div>
  );
};

export default PersistentVoiceBar;
