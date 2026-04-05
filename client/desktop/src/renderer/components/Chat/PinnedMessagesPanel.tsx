import React, { useEffect, useState, useCallback } from 'react';
import { X } from 'lucide-react';
import type { MessageWithUser } from '../../types/chat';
import { getChannelPins, unpinMessage } from '../../services/pinService';
import { e2eeService } from '../../services/e2eeService';
import './PinnedMessagesPanel.css';

function renderPinContent(
  content: string,
  isEncrypted: boolean,
  decrypted?: boolean,
  decryptFailed?: boolean
) {
  if (decryptFailed) {
    return <span className="pinned-message-encrypted">Unable to decrypt</span>;
  }
  if (isEncrypted && !decrypted) {
    return <span className="pinned-message-encrypted">Encrypted message</span>;
  }
  if (content.length > 200) {
    return content.slice(0, 200) + '...';
  }
  return content;
}

/** Decrypt pinned messages client-side using the channel's E2EE keys. */
async function decryptPins(
  channelId: string,
  msgs: MessageWithUser[]
): Promise<(MessageWithUser & { decrypted?: boolean; decryptFailed?: boolean })[]> {
  const hasEncrypted = msgs.some((m) => m.is_encrypted);
  if (!hasEncrypted || !e2eeService.isInitialized) {
    return msgs; // No decrypted flag set — renderPinContent will show placeholder
  }

  // Pre-fetch channel key once
  let channelKey: CryptoKey | null = null;
  try {
    channelKey = await e2eeService.getChannelKey(channelId);
  } catch {
    // Key may not be available yet
  }

  // Collect unique key versions for batch pre-fetch
  const versions = new Set<number>();
  for (const m of msgs) {
    if (m.is_encrypted && m.key_version && m.key_version > 1) {
      versions.add(m.key_version);
    }
  }
  const versionedKeys = new Map<number, CryptoKey>();
  for (const v of versions) {
    try {
      versionedKeys.set(v, await e2eeService.getChannelKeyByVersion(channelId, v));
    } catch {
      // Will fall back to on-demand fetch per message
    }
  }

  return Promise.all(
    msgs.map(async (m) => {
      if (!m.is_encrypted) return { ...m, decrypted: false };
      try {
        const kv = m.key_version;
        let plaintext: string;
        if (kv && kv > 1) {
          const vKey = versionedKeys.get(kv);
          plaintext = vKey
            ? await e2eeService.decryptWithKey(m.content, vKey)
            : await e2eeService.decryptForChannelWithVersion(channelId, m.content, kv);
        } else {
          plaintext = channelKey
            ? await e2eeService.decryptWithKey(m.content, channelKey)
            : await e2eeService.decryptForChannel(channelId, m.content);
        }
        return { ...m, content: plaintext, decrypted: true };
      } catch {
        return { ...m, content: '', decryptFailed: true };
      }
    })
  );
}

export interface PinnedMessagesPanelProps {
  channelId: string;
  isOpen: boolean;
  onClose: () => void;
  onScrollToMessage: (messageId: string) => void;
  canPin?: boolean;
}

const PinnedMessagesPanel: React.FC<PinnedMessagesPanelProps> = ({
  channelId,
  isOpen,
  onClose,
  onScrollToMessage,
  canPin,
}) => {
  const [pins, setPins] = useState<
    (MessageWithUser & { decrypted?: boolean; decryptFailed?: boolean })[]
  >([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setIsLoading(true);
    getChannelPins(channelId)
      .then((rawPins) => decryptPins(channelId, rawPins))
      .then(setPins)
      .catch(() => setPins([]))
      .finally(() => setIsLoading(false));
  }, [isOpen, channelId]);

  const handleUnpin = useCallback(async (messageId: string) => {
    try {
      await unpinMessage(messageId);
      setPins((prev) => prev.filter((m) => m.id !== messageId));
    } catch {
      // Silently fail — WS event will correct state
    }
  }, []);

  const handleJump = useCallback(
    (messageId: string) => {
      onScrollToMessage(messageId);
      onClose();
    },
    [onScrollToMessage, onClose]
  );

  if (!isOpen) return null;

  return (
    <div className="pinned-panel-backdrop">
      <button
        type="button"
        className="pinned-panel-backdrop-dismiss"
        onClick={onClose}
        aria-label="Close pinned messages"
      />
      <section className="pinned-panel">
        <div className="pinned-panel-header">
          <h3>Pinned Messages</h3>
          <button className="pinned-panel-close" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="pinned-panel-content">
          {isLoading && <div className="pinned-panel-loading">Loading...</div>}

          {!isLoading && pins.length === 0 && (
            <div className="pinned-panel-empty">
              <p>No pinned messages</p>
              <p className="pinned-panel-empty-hint">
                Pin important messages so they're easy to find.
              </p>
            </div>
          )}

          {!isLoading &&
            pins.map((msg) => (
              <div key={msg.id} className="pinned-message-card">
                <div className="pinned-message-meta">
                  <span className="pinned-message-author">{msg.display_name || msg.username}</span>
                </div>
                <div className="pinned-message-content">
                  {renderPinContent(
                    msg.content,
                    msg.is_encrypted,
                    msg.decrypted,
                    msg.decryptFailed
                  )}
                </div>
                <div className="pinned-message-actions">
                  <button className="pinned-message-jump" onClick={() => handleJump(msg.id)}>
                    Jump
                  </button>
                  {canPin && (
                    <button className="pinned-message-unpin" onClick={() => handleUnpin(msg.id)}>
                      Unpin
                    </button>
                  )}
                </div>
              </div>
            ))}
        </div>
      </section>
    </div>
  );
};

export default PinnedMessagesPanel;
