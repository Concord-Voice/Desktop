import React, { useRef, useCallback } from 'react';
import { useVoiceStore } from '../../stores/voiceStore';
import { useChannelStore } from '../../stores/channelStore';
import { useDocumentPip, hasDocumentPipSupport } from './useDocumentPip';
import { DocumentPipContent } from './DocumentPipContent';
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
 * and pop-out to Document PiP.
 */
const PersistentVoiceBar: React.FC = () => {
  const {
    activeChannelId,
    voiceControlsPinned,
    voiceControlsPoppedOut,
    setVoiceControlsPoppedOut,
    showVoiceTextChat,
    persistentTextChatHeight,
    setPersistentTextChatHeight,
  } = useVoiceStore();

  const getLinkedTextChannel = useChannelStore((s) => s.getLinkedTextChannel);
  const hasLinkedText = !!(activeChannelId && getLinkedTextChannel(activeChannelId));
  const showChat = showVoiceTextChat && hasLinkedText;

  const containerRef = useRef<HTMLDivElement>(null);
  const resizingRef = useRef(false);

  // Document PiP for pop-out controls
  const docPip = useDocumentPip();

  const handlePopOut = useCallback(async () => {
    if (!hasDocumentPipSupport) return;

    const win = await docPip.open({ width: 480, height: 64 });
    if (win) {
      setVoiceControlsPoppedOut(true);

      // When user closes the PiP window, restore inline bar
      win.addEventListener('pagehide', () => {
        setVoiceControlsPoppedOut(false);
      });
    }
  }, [docPip, setVoiceControlsPoppedOut]);

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

  // When popped out, render controls into PiP window instead of inline
  if (voiceControlsPoppedOut && docPip.isOpen && docPip.pipWindow) {
    return (
      <DocumentPipContent
        pipWindow={docPip.pipWindow}
        mode="controls"
      />
    );
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
      <VoiceControls context="persistent" onPopOut={handlePopOut} />
    </div>
  );
};

export default PersistentVoiceBar;
