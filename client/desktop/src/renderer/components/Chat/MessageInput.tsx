import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Smile, ImagePlay, Paperclip, Lock, Unlock } from 'lucide-react';
import MessageInputContextMenu from './MessageInputContextMenu';
import MentionAutocomplete, { type MentionAutocompleteHandle } from './MentionAutocomplete';
import EmojiPicker from '../EmojiPicker/LazyEmojiPicker';
import LazyGifPicker from '../GifPicker/LazyGifPicker';
import UserPanel from '../User/UserPanel';
import { useClientConfigStore } from '../../stores/clientConfigStore';
import { useLayoutStore } from '../../stores/layoutStore';
import { buildAddendum, encodeMentionMeta, type ParsedMention } from '../../utils/mentions';
import type { AttachmentSummary, MessageWithStatus } from '../../types/chat';
import { useFileUpload } from '../../hooks/useFileUpload';
import { useDraftMessage } from '../../hooks/useDraftMessage';
import { useChatStore } from '../../stores/chatStore';
import AttachmentUploadPreview from './AttachmentUploadPreview';
import ReplyPreviewBar from './ReplyPreviewBar';
import './MessageInput.css';

export interface MessageInputProps {
  onSendMessage: (
    content: string,
    mentionMeta?: string,
    replyToId?: string,
    attachmentIds?: string[],
    attachments?: AttachmentSummary[],
    gifSlug?: string
  ) => void;
  onTyping?: (isTyping: boolean) => void;
  placeholder?: string;
  maxLength?: number;
  disabled?: boolean;
  channelName?: string;
  isChannelEncrypted?: boolean;
  /** Server ID for permission-gated mention autocomplete (undefined in DMs) */
  serverId?: string;
  /** Channel ID for SBAC override resolution (undefined in DMs) */
  channelId?: string;
  /** DM conversation ID — used to source mention candidates from DM participants */
  conversationId?: string;
  /** Message being replied to (preview bar above textarea) */
  replyingTo?: MessageWithStatus | null;
  /** Cancel the reply */
  onCancelReply?: () => void;
  /** Whether the user has permission to attach files */
  canAttachFiles?: boolean;
}

const MessageInput: React.FC<MessageInputProps> = ({
  onSendMessage,
  onTyping,
  placeholder = 'Type a message...',
  maxLength = 4000,
  disabled = false,
  channelName,
  isChannelEncrypted = false,
  serverId,
  channelId,
  conversationId,
  replyingTo,
  onCancelReply,
  canAttachFiles = true,
}) => {
  const channelPanelPinned = useLayoutStore((s) => s.channelPanelPinned);
  const [content, setContent] = useState('');
  const draftTargetId = channelId || conversationId;
  const {
    initialDraft,
    saveDraft: saveDraftDebounced,
    clearDraft: clearDraftNow,
  } = useDraftMessage(draftTargetId);
  const [dragOver, setDragOver] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const {
    files: uploadFiles,
    addFiles,
    removeFile,
    clearFiles,
    uploadAll,
    isUploading,
    hasFiles,
  } = useFileUpload();
  const [cursorPos, setCursorPos] = useState(0);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [emojiPickerPos, setEmojiPickerPos] = useState<{
    x: number;
    y: number;
    anchorCenterX: number;
  }>({ x: 0, y: 0, anchorCenterX: 0 });
  const [showGifPicker, setShowGifPicker] = useState(false);
  const [gifPickerPos, setGifPickerPos] = useState<{ x: number; y: number; anchorCenterX: number }>(
    { x: 0, y: 0, anchorCenterX: 0 }
  );
  const klipyApiKey = useClientConfigStore((s) => s.featureFlags.klipyApiKey);
  const [showMentions, setShowMentions] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const emojiBtnRef = useRef<HTMLButtonElement>(null);
  const gifBtnRef = useRef<HTMLButtonElement>(null);
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isTypingRef = useRef(false);
  // Track mentions selected via autocomplete (for building the addendum)
  const selectedMentionsRef = useRef<ParsedMention[]>([]);
  const mentionAutocompleteRef = useRef<MentionAutocompleteHandle | null>(null);

  // Auto-focus textarea when replyingTo changes
  useEffect(() => {
    if (replyingTo && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [replyingTo]);

  // Restore draft content and reply context when channel/conversation changes
  useEffect(() => {
    if (initialDraft) {
      setContent(initialDraft.text);
      // Restore reply context if the draft had one and the message is still in memory
      if (initialDraft.replyToId && draftTargetId) {
        const messages = useChatStore.getState().messagesByChannel.get(draftTargetId);
        const replyMsg = messages?.find((m) => m.id === initialDraft.replyToId);
        if (replyMsg) {
          useChatStore.getState().setReplyingTo(draftTargetId, replyMsg);
        }
      }
    } else {
      setContent('');
    }
  }, [initialDraft, draftTargetId]);

  // Save draft when reply context changes (so switching channels preserves reply state)
  const prevReplyRef = useRef(replyingTo);
  useEffect(() => {
    if (prevReplyRef.current !== replyingTo) {
      prevReplyRef.current = replyingTo;
      if (draftTargetId) {
        saveDraftDebounced(content, replyingTo);
      }
    }
  }, [replyingTo, draftTargetId, content, saveDraftDebounced]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const handlePasteFromMenu = useCallback(
    (text: string) => {
      const textarea = textareaRef.current;
      if (!textarea) {
        // Fallback: just append
        setContent((prev) => {
          const combined = prev + text;
          return combined.length <= maxLength ? combined : combined.slice(0, maxLength);
        });
        return;
      }

      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const before = content.slice(0, start);
      const after = content.slice(end);
      const combined = before + text + after;
      const newContent = combined.length <= maxLength ? combined : combined.slice(0, maxLength);

      setContent(newContent);

      // Restore cursor position after the pasted text
      requestAnimationFrame(() => {
        const newCursor = Math.min(start + text.length, newContent.length);
        textarea.selectionStart = newCursor;
        textarea.selectionEnd = newCursor;
        textarea.focus();
      });
    },
    [content, maxLength]
  );

  const handleEmojiSelect = useCallback(
    (emoji: string) => {
      const textarea = textareaRef.current;
      if (!textarea) {
        setContent((prev) => {
          const combined = prev + emoji;
          return combined.length <= maxLength ? combined : combined.slice(0, maxLength);
        });
        setShowEmojiPicker(false);
        return;
      }

      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const before = content.slice(0, start);
      const after = content.slice(end);
      const combined = before + emoji + after;
      const newContent = combined.length <= maxLength ? combined : combined.slice(0, maxLength);

      setContent(newContent);
      setShowEmojiPicker(false);

      requestAnimationFrame(() => {
        const newCursor = Math.min(start + emoji.length, newContent.length);
        textarea.selectionStart = newCursor;
        textarea.selectionEnd = newCursor;
        textarea.focus();
      });
    },
    [content, maxLength]
  );

  const getPickerPosition = useCallback((anchor: HTMLButtonElement | null, width: number) => {
    if (!anchor) return { x: 0, y: 0, anchorCenterX: 0 };
    const rect = anchor.getBoundingClientRect();
    const pickerHeight = 520;
    const anchorCenterX = rect.left + rect.width / 2;

    // Position above the button, right-aligned to the button so the arrow
    // tail can point down at the anchor. 12px gap leaves room for the tail.
    let x = rect.right - width;
    let y = rect.top - pickerHeight - 12;

    // Viewport clamping
    x = Math.max(8, Math.min(x, globalThis.innerWidth - width - 8));
    y = Math.max(8, y);

    return { x, y, anchorCenterX };
  }, []);

  const toggleEmojiPicker = useCallback(() => {
    if (showEmojiPicker) {
      setShowEmojiPicker(false);
    } else {
      setShowGifPicker(false);
      setEmojiPickerPos(getPickerPosition(emojiBtnRef.current, 352));
      setShowEmojiPicker(true);
    }
  }, [showEmojiPicker, getPickerPosition]);

  const toggleGifPicker = useCallback(() => {
    if (showGifPicker) {
      setShowGifPicker(false);
    } else {
      setShowEmojiPicker(false);
      setGifPickerPos(getPickerPosition(gifBtnRef.current, 370));
      setShowGifPicker(true);
    }
  }, [showGifPicker, getPickerPosition]);

  const handleGifSelect = useCallback(
    (gifSlug: string) => {
      onSendMessage(' ', undefined, replyingTo?.id, undefined, undefined, gifSlug);
      setShowGifPicker(false);
      onCancelReply?.();
    },
    [onSendMessage, replyingTo, onCancelReply]
  );

  const adjustTextareaHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    // When empty, collapse to a single row
    if (!content) {
      textarea.style.height = 'auto';
      return;
    }

    // Cap at 25% of the closest .chat-view ancestor (or 200px fallback)
    const chatView = textarea.closest('.chat-view');
    const maxH = chatView ? chatView.clientHeight * 0.25 : 200;

    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, maxH) + 'px';
  }, [content]);

  useEffect(() => {
    adjustTextareaHeight();
  }, [adjustTextareaHeight]);

  // Re-adjust on window resize so the textarea doesn't retain a stale height
  useEffect(() => {
    const onResize = () => adjustTextareaHeight();
    globalThis.addEventListener('resize', onResize);
    return () => globalThis.removeEventListener('resize', onResize);
  }, [adjustTextareaHeight]);

  // Cleanup typing state on unmount
  useEffect(() => {
    return () => {
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }
      if (onTyping && isTypingRef.current) {
        onTyping(false);
      }
    };
  }, [onTyping]);

  // Detect @ trigger for mention autocomplete
  useEffect(() => {
    if (!content) {
      setShowMentions(false);
      return;
    }
    // Check if there's an active @query at cursor position
    let i = cursorPos - 1;
    while (i >= 0 && content[i] !== '@' && content[i] !== ' ' && content[i] !== '\n') {
      i--;
    }
    if (
      i >= 0 &&
      content[i] === '@' &&
      (i === 0 || content[i - 1] === ' ' || content[i - 1] === '\n')
    ) {
      setShowMentions(true);
    } else {
      setShowMentions(false);
    }
  }, [content, cursorPos]);

  const handleMentionSelect = useCallback(
    (mention: ParsedMention, replacementText: string) => {
      const textarea = textareaRef.current;
      if (!textarea) return;

      const before = content.slice(0, mention.start);
      const after = content.slice(cursorPos);
      const newContent = before + replacementText + after;

      setContent(newContent);
      setShowMentions(false);

      // Track the selected mention for building the addendum on send
      selectedMentionsRef.current.push({
        ...mention,
        start: mention.start,
        end: mention.start + replacementText.trimEnd().length,
      });

      // Move cursor after the inserted mention
      requestAnimationFrame(() => {
        const newCursor = mention.start + replacementText.length;
        textarea.selectionStart = newCursor;
        textarea.selectionEnd = newCursor;
        setCursorPos(newCursor);
        textarea.focus();
      });
    },
    [content, cursorPos]
  );

  const buildMentionMeta = (trimmedContent: string): string | undefined => {
    if (selectedMentionsRef.current.length === 0) return undefined;
    const validMentions = selectedMentionsRef.current.filter((m) => trimmedContent.includes(m.raw));
    const addendum = buildAddendum(validMentions);
    return addendum ? encodeMentionMeta(addendum) : undefined;
  };

  const stopTypingIndicator = () => {
    if (onTyping && isTypingRef.current) {
      isTypingRef.current = false;
      onTyping(false);
    }
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = null;
    }
  };

  const handleSend = async () => {
    const trimmedContent = content.trim();
    if (trimmedContent.length > maxLength) return; // block over-limit even with attachments
    const hasContent = trimmedContent.length > 0;
    if (!hasContent && !hasFiles) return;

    stopTypingIndicator();
    const mentionMeta = buildMentionMeta(trimmedContent);

    // Upload attachments (if any) before sending
    let attachmentIds: string[] | undefined;
    let attachmentSummaries: import('../../types/chat').AttachmentSummary[] | undefined;
    if (hasFiles) {
      try {
        setUploadError(null);
        const targetId = conversationId || channelId || '';
        const result = await uploadAll(targetId, isChannelEncrypted, conversationId);
        if (result.ids.length > 0) {
          attachmentIds = result.ids;
          attachmentSummaries = result.summaries;
        }
      } catch {
        setUploadError('Failed to upload attachments');
        return;
      }
    }

    const sendContent = trimmedContent || (attachmentIds ? ' ' : '');
    if (!sendContent) return;

    onSendMessage(sendContent, mentionMeta, replyingTo?.id, attachmentIds, attachmentSummaries);
    setContent('');
    clearDraftNow();
    setShowMentions(false);
    selectedMentionsRef.current = [];
    clearFiles();
    setUploadError(null);
    onCancelReply?.();
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const error = addFiles(e.target.files);
      if (error) setUploadError(error);
      else setUploadError(null);
    }
    // Reset input so same file can be re-selected
    e.target.value = '';
  };

  const handleDragOver = (e: React.DragEvent) => {
    if (!canAttachFiles) return;
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    if (!canAttachFiles || !e.dataTransfer.files.length) return;
    const error = addFiles(e.dataTransfer.files);
    if (error) setUploadError(error);
    else setUploadError(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Let mention autocomplete handle keyboard events first
    if (showMentions && mentionAutocompleteRef.current) {
      const handled = mentionAutocompleteRef.current.handleKeyDown(e);
      if (handled) return;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    if (e.target.value.length <= maxLength) {
      setContent(e.target.value);
      saveDraftDebounced(e.target.value, replyingTo);
      setCursorPos(e.target.selectionStart);
    }

    // Typing indicator logic
    if (onTyping) {
      if (!isTypingRef.current && e.target.value.length > 0) {
        isTypingRef.current = true;
        onTyping(true);
      }

      // Clear previous timeout
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }

      // If input is cleared, stop typing immediately
      if (e.target.value.length === 0) {
        if (isTypingRef.current) {
          isTypingRef.current = false;
          onTyping(false);
        }
      } else {
        // Set timeout to stop typing after 3 seconds of no input
        typingTimeoutRef.current = setTimeout(() => {
          if (isTypingRef.current) {
            isTypingRef.current = false;
            onTyping(false);
          }
        }, 3000);
      }
    }
  };

  // Track cursor position on click/selection
  const handleSelect = useCallback(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      setCursorPos(textarea.selectionStart);
    }
  }, []);

  const charactersRemaining = maxLength - content.length;
  const showCounter = content.length > maxLength * 0.8; // Show when 80% full

  return (
    <div className="message-input-container">
      {/* Always-visible E2EE status indicator */}
      <div className={`e2ee-status-bar ${isChannelEncrypted ? 'encrypted' : 'unencrypted'}`}>
        {isChannelEncrypted ? (
          <>
            <Lock size={14} />
            <span>Messages are Encrypted End-to-End</span>
          </>
        ) : (
          <>
            <Unlock size={14} />
            <span>Channel is NOT using End-to-End Encryption</span>
          </>
        )}
      </div>

      <section
        aria-label="Message composition area"
        className={`message-input-wrapper ${dragOver ? 'drag-over' : ''}`}
        style={{ position: 'relative' }}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {showMentions && (
          <MentionAutocomplete
            ref={mentionAutocompleteRef}
            text={content}
            cursorPosition={cursorPos}
            serverId={serverId}
            channelId={channelId}
            conversationId={conversationId}
            onSelect={handleMentionSelect}
            onClose={() => setShowMentions(false)}
            anchorRef={textareaRef}
          />
        )}

        {replyingTo && (
          <ReplyPreviewBar
            repliedTo={{
              id: replyingTo.id,
              user_id: replyingTo.user_id,
              username: replyingTo.username,
              display_name: replyingTo.display_name,
              content: replyingTo.content,
              is_encrypted: replyingTo.is_encrypted,
            }}
            variant="input"
            onCancel={onCancelReply}
          />
        )}

        <div className="message-input-box" onContextMenu={handleContextMenu}>
          {!channelPanelPinned && (
            <div className="message-input-user-panel">
              <UserPanel compact />
            </div>
          )}
          {hasFiles && <AttachmentUploadPreview files={uploadFiles} onRemove={removeFile} />}
          {uploadError && <div className="upload-error">{uploadError}</div>}
          <textarea
            ref={textareaRef}
            className="message-input-textarea"
            placeholder={channelName ? `Message #${channelName}` : placeholder}
            value={content}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onSelect={handleSelect}
            onPaste={(e) => {
              if (canAttachFiles && e.clipboardData.files.length > 0) {
                e.preventDefault();
                const error = addFiles(e.clipboardData.files);
                if (error) setUploadError(error);
                else setUploadError(null);
              }
            }}
            disabled={disabled}
            rows={1}
            aria-label="Message input"
          />

          <div className="message-input-actions">
            {showCounter && (
              <span className={`char-counter ${charactersRemaining < 100 ? 'warning' : ''}`}>
                {charactersRemaining}
              </span>
            )}

            <button
              className="send-button"
              onClick={handleSend}
              disabled={disabled || isUploading || (!content.trim() && !hasFiles)}
              aria-label="Send message"
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <path d="M2 10l16-8-8 16-2-6-6-2z" fill="currentColor" />
              </svg>
            </button>
          </div>
        </div>

        <div className="message-input-hints">
          <span className="hint">
            Press <kbd>Enter</kbd> to send, <kbd>Shift+Enter</kbd> for new line
          </span>
          <div className="message-input-extras">
            <button
              ref={emojiBtnRef}
              className={`media-btn ${showEmojiPicker ? 'active' : ''}`}
              title="Emoji"
              onClick={toggleEmojiPicker}
            >
              <Smile size={18} />
            </button>
            <button
              ref={gifBtnRef}
              className={`media-btn ${showGifPicker ? 'active' : ''}`}
              title="GIF"
              disabled={!klipyApiKey}
              onClick={toggleGifPicker}
            >
              <ImagePlay size={18} />
            </button>
            <button
              className="media-btn"
              title="Attach file"
              disabled={!canAttachFiles}
              onClick={() => fileInputRef.current?.click()}
            >
              <Paperclip size={18} />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              style={{ display: 'none' }}
              onChange={handleFileSelect}
            />
          </div>
        </div>
      </section>

      {showEmojiPicker && (
        <EmojiPicker
          mode="popover"
          position={emojiPickerPos}
          onSelect={handleEmojiSelect}
          onClose={() => setShowEmojiPicker(false)}
        />
      )}

      {showGifPicker && (
        <LazyGifPicker
          position={gifPickerPos}
          onSelect={handleGifSelect}
          onClose={() => setShowGifPicker(false)}
        />
      )}

      {contextMenu && (
        <MessageInputContextMenu
          position={contextMenu}
          onClose={() => setContextMenu(null)}
          onPaste={handlePasteFromMenu}
          onOpenEmojiPicker={toggleEmojiPicker}
        />
      )}
    </div>
  );
};

export default MessageInput;
