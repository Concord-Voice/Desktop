import type { MessageWithUser } from '../../types/chat';
import { e2eeService } from '../../services/e2eeService';

export type DecryptedPin = MessageWithUser & { decrypted?: boolean; decryptFailed?: boolean };

export function renderPinContent(
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
export async function decryptPins(
  contextId: string,
  msgs: MessageWithUser[]
): Promise<DecryptedPin[]> {
  const hasEncrypted = msgs.some((m) => m.is_encrypted);
  if (!hasEncrypted || !e2eeService.isInitialized) {
    return msgs; // No decrypted flag set — renderPinContent will show placeholder
  }

  // Pre-fetch channel key once
  let channelKey: CryptoKey | null = null;
  try {
    channelKey = await e2eeService.getChannelKey(contextId);
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
      versionedKeys.set(v, await e2eeService.getChannelKeyByVersion(contextId, v));
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
            : await e2eeService.decryptForChannelWithVersion(contextId, m.content, kv);
        } else {
          plaintext = channelKey
            ? await e2eeService.decryptWithKey(m.content, channelKey)
            : await e2eeService.decryptForChannel(contextId, m.content);
        }
        return { ...m, content: plaintext, decrypted: true };
      } catch {
        return { ...m, content: '', decryptFailed: true };
      }
    })
  );
}
